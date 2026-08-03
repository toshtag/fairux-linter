import { randomBytes } from "node:crypto";
import {
  closeSync,
  fchmodSync,
  fsyncSync,
  lstatSync,
  openSync,
  renameSync,
  type Stats,
  unlinkSync,
  writeSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

/**
 * Replacing a file without destroying what it was.
 *
 * Writing new contents over a path is not one operation but several decisions, and the safe answer
 * differs by what the file is for. A baseline this tool owns can be replaced outright. A source file
 * a user is editing cannot: replacing it by rename turns a symlink into a regular file, breaks a
 * hard link, and resets its mode, none of which a "safe-only" fix is allowed to do.
 *
 * So there are two contracts here over one mechanism.
 *
 * **What is guaranteed.** A failure before the rename leaves the existing file byte-for-byte
 * unchanged. No reader observes partial contents through the target's name. Each file is replaced
 * whole.
 *
 * **What is not.** Several files are several renames, so a failure partway leaves some replaced and
 * some not — reported, never hidden. Directories are not fsynced, so a rename that returned is not
 * claimed to survive a power loss. And nothing here locks: between the last check and the rename
 * there is a window no lock-free implementation can close.
 */

/**
 * The filesystem, as the parts of it this module uses.
 *
 * Injected so failures that are otherwise unreachable — a short write, a failing fsync, a failing
 * rename — are ordinary test inputs rather than something staged with directory permissions, which
 * do not stop a superuser and do not mean the same thing on Windows.
 */
export interface FileSystemOps {
  readonly open: (path: string, flags: string) => number;
  readonly write: (fd: number, buffer: Buffer, offset: number, length: number) => number;
  readonly fsync: (fd: number) => void;
  readonly close: (fd: number) => void;
  readonly fchmod: (fd: number, mode: number) => void;
  readonly rename: (from: string, to: string) => void;
  readonly unlink: (path: string) => void;
  readonly lstat: (path: string) => Stats;
  readonly randomSuffix: () => string;
}

export const nodeFileSystem: FileSystemOps = Object.freeze<FileSystemOps>({
  open: (path, flags) => openSync(path, flags),
  write: (fd, buffer, offset, length) => writeSync(fd, buffer, offset, length),
  fsync: fsyncSync,
  close: closeSync,
  fchmod: fchmodSync,
  rename: renameSync,
  unlink: unlinkSync,
  lstat: lstatSync,
  // Not the pid and a counter: a leftover temp file from a crashed run with the same pid would
  // otherwise collide forever, and `wx` turns that into a permanent inability to write.
  randomSuffix: () => randomBytes(6).toString("hex"),
});

/** What a file was when it was inspected. Everything a later check compares against. */
export interface FileIdentity {
  readonly dev: number;
  readonly ino: number;
  readonly mode: number;
  readonly nlink: number;
  readonly size: number;
}

/** The target is not something this may replace. Carries the reason a user has to act on. */
export class UnsafeTargetError extends Error {
  constructor(
    readonly path: string,
    readonly reason: string,
  ) {
    super(`"${path}" ${reason}`);
    this.name = "UnsafeTargetError";
  }
}

/** The target changed between being checked and being replaced. */
export class TargetChangedError extends Error {
  constructor(
    readonly path: string,
    readonly detail: string,
  ) {
    super(`"${path}" changed before it could be written: ${detail}`);
    this.name = "TargetChangedError";
  }
}

function identityOf(stat: Stats): FileIdentity {
  return { dev: stat.dev, ino: stat.ino, mode: stat.mode, nlink: stat.nlink, size: stat.size };
}

/**
 * Inspect a path with `lstat`, never `stat`.
 *
 * `stat` follows a symlink and reports the target, which is exactly the distinction that matters
 * here: replacing the link and replacing what it points at are different operations, and one of
 * them is silent data loss.
 */
function inspect(path: string, ops: FileSystemOps): Stats | undefined {
  try {
    return ops.lstat(path);
  } catch {
    return undefined;
  }
}

function rejectUnreplaceable(path: string, stat: Stats): void {
  if (stat.isSymbolicLink()) {
    // Following it would write through to the target, which changes a file the user did not name.
    // Replacing it turns the link into a regular file. Neither is this module's decision to make.
    throw new UnsafeTargetError(
      path,
      "is a symbolic link, and replacing it would destroy the link",
    );
  }
  if (!stat.isFile()) {
    throw new UnsafeTargetError(
      path,
      "is not a regular file (a directory, device, socket, or FIFO cannot be replaced this way)",
    );
  }
  if (stat.nlink > 1) {
    // A rename gives the name a new inode, so the other links keep the old contents and quietly stop
    // being the same file.
    throw new UnsafeTargetError(
      path,
      `has ${stat.nlink} hard links, and replacing it would break them apart`,
    );
  }
}

/**
 * A file this tool owns and may replace: a baseline, a Risk Index.
 *
 * Returns the identity of an existing target, or `undefined` when there is nothing there yet —
 * creating one is ordinary.
 */
export function assertReplaceableArtifact(
  path: string,
  ops: FileSystemOps = nodeFileSystem,
): FileIdentity | undefined {
  const stat = inspect(path, ops);
  if (!stat) return undefined;
  rejectUnreplaceable(path, stat);
  return identityOf(stat);
}

/**
 * A file the user is editing, which a fix may rewrite in place.
 *
 * Stricter than an artifact in one way: it must already exist, and it must be writable *as a file*.
 * A read-only file inside a writable directory can be replaced by rename without any permission
 * complaining, which would let `--fix-write` edit a file the user marked as not to be edited.
 */
export function assertReplaceableSource(
  path: string,
  ops: FileSystemOps = nodeFileSystem,
): FileIdentity {
  const stat = inspect(path, ops);
  if (!stat) throw new UnsafeTargetError(path, "does not exist");
  rejectUnreplaceable(path, stat);
  // The owner-write bit rather than an access check: `access(W_OK)` is true for a superuser whatever
  // the mode says, which would make this pass in CI and fail for the user it protects.
  if ((stat.mode & 0o200) === 0) {
    throw new UnsafeTargetError(path, "is read-only, and a fix does not override that");
  }
  return identityOf(stat);
}

/** Two identities differ in a way that means the file is no longer the one that was checked. */
export function describeIdentityChange(
  before: FileIdentity,
  after: FileIdentity,
): string | undefined {
  if (before.dev !== after.dev || before.ino !== after.ino) return "it is a different file now";
  if (before.nlink !== after.nlink) {
    return `its hard link count went from ${before.nlink} to ${after.nlink}`;
  }
  if (before.mode !== after.mode) return "its permissions changed";
  return undefined;
}

export interface StagedFile {
  readonly target: string;
  readonly temporary: string;
}

/**
 * Write the new contents beside the target, without touching the target.
 *
 * Same directory, because a rename across filesystems is a copy — the non-atomic operation this
 * exists to avoid. Nothing here can lose data: the target is not opened at all.
 */
export function stageReplacement(
  target: string,
  contents: string,
  options: { readonly mode?: number; readonly ops?: FileSystemOps } = {},
): StagedFile {
  const ops = options.ops ?? nodeFileSystem;
  const absolute = resolve(target);
  const temporary = join(
    dirname(absolute),
    `.${basename(absolute)}.${ops.randomSuffix()}.fairux-tmp`,
  );

  let descriptor: number | undefined;
  try {
    // `wx` rather than `w`: if this name exists it is not ours, and truncating it would be the
    // failure this module is about.
    descriptor = ops.open(temporary, "wx");
    // Before the contents, so the file is never readable at a wider mode than it will end at.
    if (options.mode !== undefined) ops.fchmod(descriptor, options.mode);

    const buffer = Buffer.from(contents, "utf8");
    let offset = 0;
    while (offset < buffer.length) {
      // `write` may write less than it was asked to, and treating one call as the whole write is how
      // a truncated file gets renamed into place as if it were complete.
      const written = ops.write(descriptor, buffer, offset, buffer.length - offset);
      if (written <= 0) {
        throw new Error(
          `wrote ${offset} of ${buffer.length} bytes to "${temporary}" and stopped making progress`,
        );
      }
      offset += written;
    }

    ops.fsync(descriptor);
    ops.close(descriptor);
    descriptor = undefined;
    return { target: absolute, temporary };
  } catch (error) {
    if (descriptor !== undefined) {
      try {
        ops.close(descriptor);
      } catch {
        // Already closed or never usable; the unlink is what matters.
      }
    }
    try {
      ops.unlink(temporary);
    } catch {
      // Never created, or already gone. A cleanup failure must not replace the real error — that
      // error is the one that says what went wrong.
    }
    throw error;
  }
}

/**
 * Put a staged file in place.
 *
 * `verify` runs immediately before the rename and throws to abort it. That is as close to the write
 * as a check can get without a lock: the window between the last check and the rename cannot be
 * closed lock-free, only made small and stated plainly.
 */
export function commitStaged(
  staged: StagedFile,
  options: { readonly verify?: () => void; readonly ops?: FileSystemOps } = {},
): void {
  const ops = options.ops ?? nodeFileSystem;
  try {
    options.verify?.();
  } catch (error) {
    discardStaged(staged, ops);
    throw error;
  }
  try {
    ops.rename(staged.temporary, staged.target);
  } catch (error) {
    discardStaged(staged, ops);
    throw error;
  }
}

/** Throw away a staged file. Never throws: the caller is already handling something worse. */
export function discardStaged(staged: StagedFile, ops: FileSystemOps = nodeFileSystem): void {
  try {
    ops.unlink(staged.temporary);
  } catch {
    // Gone already, or unremovable. Neither changes the target.
  }
}

/**
 * Replace a file this tool owns, in one call.
 *
 * The existing mode is carried over, so a baseline a user restricted to `0600` does not come back
 * world-readable because it was rewritten.
 */
export function replaceArtifact(
  path: string,
  contents: string,
  ops: FileSystemOps = nodeFileSystem,
): void {
  const existing = assertReplaceableArtifact(path, ops);
  const staged = stageReplacement(path, contents, {
    ops,
    ...(existing ? { mode: existing.mode & 0o7777 } : {}),
  });
  commitStaged(staged, {
    ops,
    verify: () => {
      const now = assertReplaceableArtifact(path, ops);
      if (!existing || !now) return;
      const change = describeIdentityChange(existing, now);
      if (change) throw new TargetChangedError(path, change);
    },
  });
}
