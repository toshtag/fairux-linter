/**
 * One `pnpm verify:full` per worktree, enforced rather than remembered.
 *
 * Two runs in the same checkout both run `pnpm build`, and they rewrite `dist/` under each other.
 * What that looks like is not a lock error: it is `Cannot find module '@fairux/dom'` in three CLI
 * tests that finished in 48ms, on a tree where nothing is wrong. That happened repeatedly during
 * this repository's own development, and each time cost a discarded measurement and a re-run —
 * the failure is indistinguishable from a real regression until you notice the other terminal.
 *
 * ## What this is, and what it is not
 *
 * `openSync(path, "wx")` — one atomic syscall that creates a file only if it does not exist. It is
 * the only thing that decides an owner. There is no daemon, no timeout, no polling, and no
 * dependency: acquiring is a create, releasing is an unlink.
 *
 * It is not a mutex across machines, and it does not protect `dist/` from anything else. `pnpm
 * build` in one terminal and `pnpm verify:full` in another still collide, and no lock in this file
 * would stop them. What it removes is the one collision that produced a *plausible* failure.
 *
 * ## The pid check
 *
 * `process.kill(pid, 0)` sends no signal; it reports whether the process exists. `ESRCH` means gone,
 * so the lock is stale. `EPERM` means it exists and belongs to somebody else, which is still alive.
 * Node implements both on Windows, which is why this needs no platform branch.
 *
 * Its one hole is pid reuse: a lock left by a killed run whose number a later process inherited
 * reads as held. The cost is one misleading refusal and a file to delete, against a failure mode
 * that costs a wasted run and a wrong diagnosis. The message names the file so the way out is
 * obvious.
 *
 * ## Taking over a stale lock, without two owners
 *
 * The first version deleted a stale lock and then created its own:
 *
 *     rmSync(lockFile);           // ← A and B both reach here
 *     openSync(lockFile, "wx");
 *
 * Two runs that read the same stale lock both pass the liveness test. A deletes, A creates, A owns.
 * B then deletes — **A's live lock** — and creates its own. Both run, and the collision the file
 * exists to prevent happens with a lock file sitting there saying otherwise.
 *
 * Nothing here deletes a path it has not first taken out of the way. Takeover is a `renameSync` to
 * a name unique to this attempt, followed by reading *what was actually moved*:
 *
 * - the record this attempt judged stale — the takeover was legitimate; drop it and loop, where
 *   `wx` decides the winner between contenders the way it decides everything else;
 * - a different record — another contender created a live lock between the read and the rename, and
 *   this attempt moved *that*. It is renamed back and the loop runs again, which now sees a live
 *   holder and refuses.
 *
 * `renameSync` is one syscall, so exactly one contender can move a given file; the loser gets
 * `ENOENT` and loops. Every branch ends in a loop rather than in a create, so the only thing that
 * ever grants ownership is `openSync(…, "wx")`.
 *
 * ## The ownership token
 *
 * A pid is not enough to tell two locks apart — a run that is killed and restarted can reuse one,
 * and the takeover check above has to compare records rather than processes. Each attempt carries a
 * `randomUUID`, and **release unlinks only a lock file that still carries its own token**. That is
 * what stops a stale release closure — a signal handler firing late, or the exit hook after a
 * takeover — from deleting the lock a *different* run now holds.
 */

import { randomUUID } from "node:crypto";
import { closeSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";

export class VerifyFullLockError extends Error {
  constructor(message) {
    super(message);
    this.name = "VerifyFullLockError";
  }
}

/**
 * How many times an attempt may lose a takeover race before giving up.
 *
 * A bound rather than a retry loop with a delay: each round is a rename and a read, and losing more
 * than a couple in a row means something is contending that this file does not model. Refusing then
 * is honest, and it cannot spin.
 */
const MAX_ATTEMPTS = 5;

/** Whether a pid names a process that exists. */
export function processIsAlive(pid, kill = process.kill.bind(process)) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    kill(pid, 0);
    return true;
  } catch (error) {
    // Alive but not ours to signal. Absent is `ESRCH`; anything else is treated as alive, because
    // taking a lock on an unreadable answer is the failure this exists to prevent.
    return error?.code !== "ESRCH";
  }
}

/** The record in a lock file, or null when it is absent or not JSON. */
function recordIn(lockFile, read = readFileSync) {
  try {
    const parsed = JSON.parse(read(lockFile, "utf8"));
    return typeof parsed === "object" && parsed !== null ? parsed : null;
  } catch {
    // Absent, or a half-written file from a run that died between the create and the write.
    return null;
  }
}

/**
 * Read a lock file, if it names a run that is still going.
 *
 * @returns {{pid: number, token: string, startedAt: string} | null}
 *   null when absent, unreadable, or stale
 */
export function heldBy(lockFile, { read = readFileSync, alive = processIsAlive } = {}) {
  const record = recordIn(lockFile, read);
  return record && alive(record.pid) ? record : null;
}

/**
 * Take the lock, or throw naming the run that has it.
 *
 * @param {string} lockFile
 * @returns {() => void}  release, safe to call more than once and after another run has taken over
 */
export function acquireVerifyFullLock(lockFile) {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const token = randomUUID();
    let handle;
    try {
      handle = openSync(lockFile, "wx");
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const holder = heldBy(lockFile);
      if (holder) {
        throw new VerifyFullLockError(
          `another verify:full is already running in this worktree (pid ${holder.pid}, started ${holder.startedAt}).\n` +
            "Two runs share one `dist/` and rewrite it under each other, which surfaces as module\n" +
            "resolution failures in tests that are fine. Wait for it, or if that process is gone,\n" +
            `delete ${lockFile}`,
        );
      }
      takeOverStaleLock(lockFile, recordIn(lockFile), token);
      continue;
    }

    writeFileSync(handle, JSON.stringify({ pid: process.pid, token, startedAt: nowIso() }));
    try {
      closeSync(handle);
    } catch {
      // The record is on disk; a handle this process can no longer close changes nothing about it.
    }
    return () => releaseIfOurs(lockFile, token);
  }

  throw new VerifyFullLockError(
    `could not take the verify:full lock after ${MAX_ATTEMPTS} attempts: ${lockFile} is being\n` +
      "created and removed by something else. Check for other runs, then delete it.",
  );
}

/** Kept in one place so the record's shape is written once. */
function nowIso() {
  return new Date().toISOString();
}

/**
 * Move a stale lock out of the way, and put it back if it turned out not to be the stale one.
 *
 * Never deletes `lockFile` directly. The rename is what makes this safe: one syscall, so exactly
 * one contender moves a given file, and the mover can then read what it actually took.
 *
 * Exported so a test can drive the interleaving that matters: a contender reads a stale record,
 * *another run wins the lock in the gap*, and only then does the first contender act on what it
 * read. Called through `acquireVerifyFullLock` that window is a few syscalls wide, and a test that
 * raced two processes for it would pass by luck.
 *
 * @param {string} lockFile
 * @param {object | null} judged  the record this attempt read and judged stale
 * @param {string} token  this attempt's token, used to name the file it moves
 */
export function takeOverStaleLock(lockFile, judged, token) {
  const graveyard = `${lockFile}.${token}.stale`;
  try {
    renameSync(lockFile, graveyard);
  } catch (error) {
    // Gone between the read and the rename — another contender moved it. Nothing to undo.
    if (error?.code === "ENOENT") return;
    throw error;
  }

  const moved = recordIn(graveyard);
  const isTheStaleOne =
    moved === null || judged === null || (moved.token ?? null) === (judged.token ?? null);
  if (isTheStaleOne) {
    rmSync(graveyard, { force: true });
    return;
  }

  // A live lock created between the read and the rename. Put it back rather than keeping it: the
  // caller loops, sees a holder, and refuses — which is the answer it should have had all along.
  try {
    renameSync(graveyard, lockFile);
  } catch {
    // Somebody created a lock in the gap. Theirs is the live one; drop the copy taken by mistake.
    rmSync(graveyard, { force: true });
  }
}

/** Unlink the lock only while it is still the one this attempt created. */
function releaseIfOurs(lockFile, token) {
  const record = recordIn(lockFile);
  if (record?.token !== token) return;
  rmSync(lockFile, { force: true });
}
