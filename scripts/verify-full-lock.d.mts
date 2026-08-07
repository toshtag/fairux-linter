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
): { pid: number; token: string; startedAt: string } | null;

/**
 * Take the worktree's verify:full lock, or throw `VerifyFullLockError`.
 *
 * The returned release unlinks the lock only while it still carries this attempt's token, so a late
 * signal handler cannot remove the lock a later run holds.
 */
export declare function acquireVerifyFullLock(lockFile: string): () => void;

/**
 * Move a stale lock out of the way, putting it back if what moved was not the record judged stale.
 *
 * Exported for the interleaving test; `acquireVerifyFullLock` is the entry point.
 */
export declare function takeOverStaleLock(
  lockFile: string,
  judged: { token?: string } | null,
  token: string,
): void;
