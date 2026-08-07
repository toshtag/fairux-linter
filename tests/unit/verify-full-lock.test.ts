import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  acquireVerifyFullLock,
  heldBy,
  processIsAlive,
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

  it("takes over a lock file that was never finished being written", () => {
    // `openSync` creates before `writeFileSync` fills it. A run that died between the two leaves
    // zero bytes, which is not JSON and is not a holder.
    writeFileSync(lockFile, "");
    const release = acquireVerifyFullLock(lockFile);
    expect(JSON.parse(readFileSync(lockFile, "utf8")).pid).toBe(process.pid);
    release();
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
