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
 * `openSync(path, "wx")` — one atomic syscall that creates a file only if it does not exist. The
 * holder writes its own pid, and a lock whose pid is gone is stale and taken over. There is no
 * daemon, no timeout, no polling, and no dependency: acquiring is a create, releasing is an unlink.
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
 */

import { closeSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";

export class VerifyFullLockError extends Error {
  constructor(message) {
    super(message);
    this.name = "VerifyFullLockError";
  }
}

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

/**
 * Read a lock file, if it names a run that is still going.
 *
 * @returns {{pid: number, startedAt: string} | null}  null when absent, unreadable, or stale
 */
export function heldBy(lockFile, { read = readFileSync, alive = processIsAlive } = {}) {
  let parsed;
  try {
    parsed = JSON.parse(read(lockFile, "utf8"));
  } catch {
    // Absent, or a half-written file from a run that died mid-write. Neither is a live holder.
    return null;
  }
  return alive(parsed?.pid) ? parsed : null;
}

/**
 * Take the lock, or throw naming the run that has it.
 *
 * @param {string} lockFile
 * @returns {() => void}  release, safe to call more than once
 */
export function acquireVerifyFullLock(lockFile) {
  const take = () => {
    const handle = openSync(lockFile, "wx");
    writeFileSync(
      handle,
      JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }),
    );
    return handle;
  };

  let handle;
  try {
    handle = take();
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
    // Stale: the recorded pid is gone. Clear it and take the lock, once — a second EEXIST means
    // another run won the race in between, and it is the live holder.
    rmSync(lockFile, { force: true });
    handle = take();
  }

  let released = false;
  return () => {
    if (released) return;
    released = true;
    try {
      closeSync(handle);
    } catch {
      // Already closed, or the process is on its way out. Neither changes what release has to do.
    }
    // Only ever our own: this closure exists solely on the path that created the file.
    rmSync(lockFile, { force: true });
  };
}
