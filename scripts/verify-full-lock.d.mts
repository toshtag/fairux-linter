export declare class VerifyFullLockError extends Error {}

/** Whether a pid names a process that exists. `kill` is injectable so the cases can be exercised. */
export declare function processIsAlive(
  pid: number,
  kill?: (pid: number, signal: number) => void,
): boolean;

/** The run holding a lock file, or null when it is absent, unreadable, or stale. */
export declare function heldBy(
  lockFile: string,
  options?: {
    read?: (file: string, encoding: "utf8") => string;
    alive?: (pid: number) => boolean;
  },
): { pid: number; startedAt: string } | null;

/** Take the worktree's verify:full lock, or throw `VerifyFullLockError`. Returns release. */
export declare function acquireVerifyFullLock(lockFile: string): () => void;
