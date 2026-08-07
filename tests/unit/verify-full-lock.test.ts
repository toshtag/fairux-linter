import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  acquireVerifyFullLock,
  heldBy,
  processIsAlive,
  takeOverStaleLock,
  VerifyFullLockError,
} from "../../scripts/verify-full-lock.mjs";

/**
 * The guard against two `pnpm verify:full` runs in one worktree.
 *
 * The failure it prevents does not look like a failure of the tool: both runs call `pnpm build`, and
 * the loser reports `Cannot find module '@fairux/dom'` in three CLI tests that finished in 48ms. On
 * a correct tree. That is why this is a refusal at the start rather than a warning — by the time the
 * symptom appears it is indistinguishable from a regression.
 *
 * The two cases that matter are the two that a naive lock gets wrong: a *live* holder must be
 * refused, and a *dead* one must be taken over rather than left to be deleted by hand.
 */

let dir: string;
let lockFile: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "fairux-lock-"));
  lockFile = join(dir, ".verify-full.lock");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("the verify:full worktree lock", () => {
  it("takes a free lock and records who holds it", () => {
    const release = acquireVerifyFullLock(lockFile);
    expect(existsSync(lockFile)).toBe(true);
    expect(JSON.parse(readFileSync(lockFile, "utf8")).pid).toBe(process.pid);
    release();
    expect(existsSync(lockFile)).toBe(false);
  });

  it("releases idempotently, so a signal handler and the exit hook cannot double-unlink", () => {
    const release = acquireVerifyFullLock(lockFile);
    release();
    const other = acquireVerifyFullLock(lockFile);
    // A second call to the first release must not remove the lock the *next* run now holds.
    release();
    expect(existsSync(lockFile)).toBe(true);
    other();
  });

  it("does not let a stale release closure unlink the lock a later run holds", () => {
    // The same shape as above but through a *takeover*, which is where it actually bites: a run is
    // killed, its exit hook fires late, and by then somebody else owns the worktree. Release is
    // keyed on the token in the file rather than on having once created one.
    const first = acquireVerifyFullLock(lockFile);
    const stolen = JSON.parse(readFileSync(lockFile, "utf8"));

    // Rewrite the record as a dead process, which is what a killed run leaves behind.
    writeFileSync(lockFile, JSON.stringify({ ...stolen, pid: 2 ** 30 }));
    const second = acquireVerifyFullLock(lockFile);
    const owner = JSON.parse(readFileSync(lockFile, "utf8"));
    expect(owner.token).not.toBe(stolen.token);

    first();
    expect(existsSync(lockFile), "the first run's release removed the second run's lock").toBe(
      true,
    );
    expect(JSON.parse(readFileSync(lockFile, "utf8")).token).toBe(owner.token);
    second();
    expect(existsSync(lockFile)).toBe(false);
  });

  it("gives exactly one owner when two contenders take over the same stale lock", () => {
    // The race the first version had, in the order that produces it:
    //
    //   B reads the stale record and judges it dead
    //   A acquires — deletes the stale lock, creates its own, owns the worktree
    //   B acts on what it read a moment ago
    //
    // The old code's third step was `rmSync(lockFile)`, which deleted *A's live lock*, and B then
    // created its own. Two owners, and a lock file on disk saying there was one.
    //
    // Driven through `takeOverStaleLock` rather than by racing processes, because that window is a
    // few syscalls wide and a spawn-based test would hit it by luck.
    const stale = { pid: 2 ** 30, token: "stale-token", startedAt: "2026-08-07T00:00:00.000Z" };
    writeFileSync(lockFile, JSON.stringify(stale));

    // B reads it. Nothing on disk changes.
    const judgedByB = JSON.parse(readFileSync(lockFile, "utf8"));

    // A wins the lock outright.
    const a = acquireVerifyFullLock(lockFile);
    const ownerA = JSON.parse(readFileSync(lockFile, "utf8"));
    expect(ownerA.token).not.toBe(stale.token);

    // B now acts on its stale reading. It must not remove what A holds.
    takeOverStaleLock(lockFile, judgedByB, "b-token");

    expect(existsSync(lockFile), "B removed the lock A holds").toBe(true);
    expect(JSON.parse(readFileSync(lockFile, "utf8"))).toEqual(ownerA);
    // Nothing left lying around under a takeover name, in either direction.
    expect(readdirSync(dir)).toEqual([".verify-full.lock"]);

    // And the acquire B would go on to make refuses, because A is alive and holding.
    expect(() => acquireVerifyFullLock(lockFile)).toThrow(VerifyFullLockError);
    a();
  });

  it("removes a stale lock it moved when that is what it really was", () => {
    // The other half: the takeover has to actually work, or every run after a killed one refuses.
    const stale = { pid: 2 ** 30, token: "stale-token", startedAt: "2026-08-07T00:00:00.000Z" };
    writeFileSync(lockFile, JSON.stringify(stale));

    takeOverStaleLock(lockFile, stale, "b-token");
    expect(existsSync(lockFile)).toBe(false);
    expect(readdirSync(dir)).toEqual([]);
  });

  it("does nothing when the stale lock is already gone", () => {
    // The contender that lost the rename. `ENOENT` is not a failure; it means somebody else moved
    // it, and the loop will decide the owner with `wx` as usual.
    expect(() => takeOverStaleLock(lockFile, { token: "stale-token" }, "b-token")).not.toThrow();
    expect(readdirSync(dir)).toEqual([]);
  });

  it("leaves no takeover file behind after a legitimate takeover", () => {
    writeFileSync(lockFile, JSON.stringify({ pid: 2 ** 30, token: "t", startedAt: "x" }));
    const release = acquireVerifyFullLock(lockFile);
    expect(readdirSync(dir)).toEqual([".verify-full.lock"]);
    release();
    expect(readdirSync(dir)).toEqual([]);
  });

  it("refuses a second run while the first is alive", () => {
    const release = acquireVerifyFullLock(lockFile);
    try {
      expect(() => acquireVerifyFullLock(lockFile)).toThrow(VerifyFullLockError);
      expect(() => acquireVerifyFullLock(lockFile)).toThrow(
        /another verify:full is already running in this worktree/,
      );
    } finally {
      release();
    }
  });

  it("takes over a lock whose process is gone", () => {
    // The case a plain `wx` lock gets wrong. A run killed with Ctrl-C before its handler ran leaves
    // this file behind, and refusing every later run until somebody deletes it by hand is worse
    // than the collision the lock exists for.
    writeFileSync(
      lockFile,
      JSON.stringify({ pid: 2 ** 30, startedAt: "2026-08-07T00:00:00.000Z" }),
    );
    const release = acquireVerifyFullLock(lockFile);
    expect(JSON.parse(readFileSync(lockFile, "utf8")).pid).toBe(process.pid);
    release();
  });

  it.each([
    ["an empty file, from a run that died between the create and the write", ""],
    ["a truncated record", '{"pid": 12'],
    ["a JSON value that is not an object", '"held"'],
    ["a record with no pid", '{"token": "t"}'],
  ])("takes over %s", (_label, contents) => {
    // `openSync` creates before `writeFileSync` fills it, so a run that died between the two leaves
    // something that is not a holder. None of these may refuse a later run, and none may be read as
    // a pid to signal.
    writeFileSync(lockFile, contents);
    const release = acquireVerifyFullLock(lockFile);
    expect(JSON.parse(readFileSync(lockFile, "utf8")).pid).toBe(process.pid);
    release();
    expect(existsSync(lockFile)).toBe(false);
  });

  it("writes a token that differs between attempts", () => {
    // Release is keyed on it, and the takeover check compares records with it. Two runs that reused
    // one would each be able to unlink the other's lock.
    const first = acquireVerifyFullLock(lockFile);
    const one = JSON.parse(readFileSync(lockFile, "utf8")).token;
    first();
    const second = acquireVerifyFullLock(lockFile);
    const two = JSON.parse(readFileSync(lockFile, "utf8")).token;
    second();
    expect(typeof one).toBe("string");
    expect(one).not.toBe(two);
  });
});

describe("deciding whether the recorded process is still running", () => {
  it("reports this process as alive", () => {
    expect(processIsAlive(process.pid)).toBe(true);
  });

  it.each([[0], [-1], [Number.NaN], [1.5]])("rejects %s as a pid", (pid) => {
    expect(processIsAlive(pid as number)).toBe(false);
  });

  it("treats ESRCH as gone and everything else as alive", () => {
    // `EPERM` is a process that exists and is not ours to signal — a lock held by another user's
    // run, which must not be stolen. Anything unexpected is read the same way, because taking a
    // lock on an answer we did not understand is the failure this prevents.
    const throwing = (code: string) => () => {
      throw Object.assign(new Error(code), { code });
    };
    expect(processIsAlive(1234, throwing("ESRCH"))).toBe(false);
    expect(processIsAlive(1234, throwing("EPERM"))).toBe(true);
    expect(processIsAlive(1234, throwing("EINVAL"))).toBe(true);
  });

  it("reports no holder for a lock file that is not there", () => {
    expect(heldBy(join(dir, "absent.lock"))).toBeNull();
  });
});
