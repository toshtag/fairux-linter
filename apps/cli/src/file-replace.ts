import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  fchmodSync,
  fchownSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
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
 * differs by what the file is for. A baseline this tool owns can be replaced. A source file a user is
 * editing cannot be replaced by rename without changing what it *is*: a symlink becomes a regular
 * file, a hard link is broken apart, and the mode and owner become the running process's.
 *
 * So there are two contracts here over one mechanism, and both are about the same question: is the
 * thing at this path still exactly what it was when the decision to write was made?
 *
 * **What is guaranteed.** A failure before the rename leaves the existing file byte-for-byte
 * unchanged. Nothing reading the *target's* name ever sees partial contents. Each file is replaced
 * whole. Mode, owner, and group survive the replacement, or the replacement does not happen. The
 * staged file's own identity and bytes are re-checked immediately before it is renamed, so what
 * lands under the target's name is what this process wrote.
 *
 * **What is not.** The staged file is a directory entry, created `0600`. Group and other cannot read
 * it; another process running as the same user can read it, change it, or replace it — which is why
 * it is verified rather than trusted. Several files are several renames, so a failure partway leaves
 * some replaced and some not — reported, never hidden. Directories are not fsynced, so a rename that
 * returned is not claimed to survive a power loss. ACLs, extended attributes, alternate data
 * streams, and Windows security descriptors are not carried across, and a target carrying them is
 * replaced without them. And nothing here locks: between the last check and each rename — the
 * target's and the staged file's — there is a window no lock-free implementation can close.
 */

/**
 * The filesystem, as the parts of it this module uses.
 *
 * Injected so failures that are otherwise unreachable — a short write, a failing fsync, an
 * unreadable target — are ordinary test inputs rather than something staged with directory
 * permissions, which do not stop a superuser and do not mean the same thing on Windows.
 */
export interface FileSystemOps {
  readonly open: (path: string, flags: string, mode?: number) => number;
  readonly write: (fd: number, buffer: Buffer, offset: number, length: number) => number;
  readonly fsync: (fd: number) => void;
  readonly close: (fd: number) => void;
  readonly fchmod: (fd: number, mode: number) => void;
  readonly fchown: (fd: number, uid: number, gid: number) => void;
  readonly rename: (from: string, to: string) => void;
  readonly unlink: (path: string) => void;
  readonly lstat: (path: string) => Stats;
  readonly readBytes: (path: string) => Buffer;
  readonly randomSuffix: () => string;
  /** `undefined` where the process has no POSIX uid — Windows. */
  readonly currentUid: () => number | undefined;
}

export const nodeFileSystem: FileSystemOps = Object.freeze<FileSystemOps>({
  open: (path, flags, mode) => openSync(path, flags, mode),
  write: (fd, buffer, offset, length) => writeSync(fd, buffer, offset, length),
  fsync: fsyncSync,
  close: closeSync,
  fchmod: fchmodSync,
  fchown: fchownSync,
  rename: renameSync,
  unlink: unlinkSync,
  lstat: lstatSync,
  readBytes: (path) => readFileSync(path),
  // Not the pid and a counter: a leftover temp file from a crashed run with the same pid would
  // otherwise collide forever, and `wx` turns that into a permanent inability to write.
  randomSuffix: () => randomBytes(6).toString("hex"),
  currentUid: () => process.getuid?.(),
});

/** The mode a staged file is created with: readable and writable by its owner, nobody else. */
const STAGED_MODE = 0o600;

/**
 * The hash of the bytes, never of the decoded text.
 *
 * Decoding first maps every invalid sequence onto the same replacement character, so two files that
 * differ in their bytes hash identically — and a file's identity is its bytes.
 */
function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** What a file was when it was inspected. Everything a later check compares against. */
export interface FileIdentity {
  readonly dev: number;
  readonly ino: number;
  readonly mode: number;
  readonly nlink: number;
  readonly size: number;
  readonly uid: number;
  readonly gid: number;
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

/**
 * A write failed *and* its staged file could not be removed.
 *
 * Both halves are reported. The staged file holds the contents that were going to be written — for a
 * fix, a user's own source with an edit applied — so leaving it unnamed hands someone a file they
 * did not create with no way to know what it is.
 */
export class StagedFileLeftBehindError extends Error {
  constructor(
    override readonly cause: unknown,
    readonly temporaryPath: string,
    readonly cleanupError: Error,
  ) {
    super(
      `${cause instanceof Error ? cause.message : String(cause)} — and the staged file ` +
        `"${temporaryPath}" could not be removed (${cleanupError.message}), so it is left behind ` +
        `and may hold the new contents. Check it and delete it by hand.`,
    );
    this.name = "StagedFileLeftBehindError";
  }
}

function identityOf(stat: Stats): FileIdentity {
  return {
    dev: stat.dev,
    ino: stat.ino,
    mode: stat.mode,
    nlink: stat.nlink,
    size: stat.size,
    uid: stat.uid,
    gid: stat.gid,
  };
}

/** Only "there is nothing at this path" is absence. Anything else is a question with no answer. */
function isNotFound(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

/**
 * Inspect a path with `lstat`, never `stat`, and fail closed.
 *
 * `stat` follows a symlink and reports the target, which is exactly the distinction that matters:
 * replacing the link and replacing what it points at are different operations, and one of them is
 * silent data loss.
 *
 * A catch-all that returned "absent" would turn `EACCES`, `EIO`, and every unknown error into
 * permission to create a file — over whatever is actually there.
 */
function inspect(path: string, ops: FileSystemOps): Stats | undefined {
  try {
    return ops.lstat(path);
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
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

/** A file's whole observable state: whether it is there, and if so, what and which bytes. */
export type ArtifactSnapshot =
  | { readonly state: "absent" }
  | { readonly state: "present"; readonly identity: FileIdentity; readonly checksum: string };

/**
 * Everything about the target that has to still be true at the rename.
 *
 * The checksum is the part identity cannot supply: a file edited in place keeps its inode, and an
 * edit that replaces one line with another of the same length keeps its size too.
 */
export function snapshotArtifact(
  path: string,
  ops: FileSystemOps = nodeFileSystem,
): ArtifactSnapshot {
  const stat = inspect(path, ops);
  if (!stat) return { state: "absent" };
  rejectUnreplaceable(path, stat);
  return { state: "present", identity: identityOf(stat), checksum: sha256(ops.readBytes(path)) };
}

/**
 * A file the user is editing, which a fix may rewrite in place.
 *
 * Stricter than an artifact in two ways. It must already exist. And this process must be able to
 * write it *as a file*, not merely able to rename over it — a read-only file, or one owned by
 * somebody else, sits inside a directory this process may well be allowed to write, and replacing it
 * by rename would succeed where opening it for writing would not.
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

  const uid = ops.currentUid();
  // No POSIX uid — Windows, where ownership is an ACL question this does not model. The mode check
  // above still applies, because Node maps the read-only attribute onto it.
  if (uid === undefined) return identityOf(stat);
  if (uid !== 0 && stat.uid !== uid) {
    // Renaming over it would work — the directory allows it — and would silently transfer the file
    // to this user. The owner-write bit says *its owner* may write it, which is not the same as
    // saying this process may.
    throw new UnsafeTargetError(
      path,
      `is owned by another user (uid ${stat.uid}), and replacing it would take ownership of it`,
    );
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
  if (before.uid !== after.uid || before.gid !== after.gid) return "its owner changed";
  if (before.mode !== after.mode) return "its permissions changed";
  if (before.size !== after.size) return "its size changed";
  return undefined;
}

/** Every transition from the first look to the commit, and whether it is one this may write over. */
export function describeArtifactChange(
  before: ArtifactSnapshot,
  after: ArtifactSnapshot,
): string | undefined {
  if (before.state === "absent" && after.state === "absent") return undefined;
  if (before.state === "absent") {
    // Nothing about "it was not there when we started" makes it ours to overwrite now.
    return "something else created it while this was being written";
  }
  if (after.state === "absent") {
    // A deletion is a decision somebody made. Putting the file back is not this tool's call.
    return "it was deleted while this was being written";
  }
  const identityChange = describeIdentityChange(before.identity, after.identity);
  if (identityChange) return identityChange;
  if (before.checksum !== after.checksum) return "its contents changed";
  return undefined;
}

/**
 * A file this process created, wrote, and closed — with what it was at that moment.
 *
 * The snapshot is the point. A staged file sits in the target's directory under a name anything can
 * find, and between being closed and being renamed it can be edited, replaced, or linked. Renaming
 * without checking publishes whatever is there now under the target's name, and reports success.
 */
export interface StagedFile {
  readonly target: string;
  readonly temporary: string;
  readonly identity: FileIdentity;
  /** SHA-256 of the bytes as written. */
  readonly checksum: string;
}

/** What became of a staged file that was thrown away. */
export interface DiscardOutcome {
  readonly temporary: string;
  readonly removed: boolean;
  readonly error?: Error;
  /**
   * The path holds something that is not the staged file any more, so it was left alone.
   *
   * Removing by name would delete whatever took the name. Reported rather than removed, and rather
   * than ignored: the staged file itself may still be somewhere, and something unexpected is here.
   */
  readonly notOurs?: boolean;
}

/**
 * Write the new contents beside the target, without touching the target.
 *
 * Same directory, because a rename across filesystems is a copy — the non-atomic operation this
 * exists to avoid. Nothing here can lose data: the target is not opened at all.
 *
 * The staged file is created private and stays private until its contents are complete. Another
 * process sharing this directory can list and open it by name, so a file created at the target's
 * final mode would be readable by them while it was still empty or half-written.
 */
export function stageReplacement(
  target: string,
  contents: string,
  options: { readonly preserve?: FileIdentity; readonly ops?: FileSystemOps } = {},
): StagedFile {
  const ops = options.ops ?? nodeFileSystem;
  const absolute = resolve(target);
  const temporary = join(
    dirname(absolute),
    `.${basename(absolute)}.${ops.randomSuffix()}.fairux-tmp`,
  );

  // `wx` rather than `w`: if this name exists it is not ours, and truncating it would be the
  // failure this module is about. Outside the try below, because until this returns there is no
  // file of ours at that path — and a failure here must not remove the file that is.
  const descriptor0 = ops.open(temporary, "wx", STAGED_MODE);

  let descriptor: number | undefined = descriptor0;
  try {
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

    if (options.preserve) {
      // After the contents, in this order: writing clears setuid and setgid on some platforms, so a
      // mode applied first would not survive its own file being written.
      applyOwnership(descriptor, temporary, options.preserve, ops);
      ops.fchmod(descriptor, options.preserve.mode & 0o7777);
      // Again, for the metadata: the rename publishes a name whose mode and owner must already be
      // what they will be, not what they were when the contents landed.
      ops.fsync(descriptor);
    }

    ops.close(descriptor);
    descriptor = undefined;

    // What this process just wrote, recorded so the commit can prove it is still that. Taken after
    // the close so the size and mode are final rather than mid-write.
    const stat = ops.lstat(temporary);
    return {
      target: absolute,
      temporary,
      identity: identityOf(stat),
      checksum: sha256(ops.readBytes(temporary)),
    };
  } catch (error) {
    if (descriptor !== undefined) {
      try {
        ops.close(descriptor);
      } catch {
        // Already closed or never usable; removing the file is what matters.
      }
    }
    // Ours to remove: the open succeeded, so this path holds a file this process created.
    throw failWith(error, discardByPath(temporary, ops));
  }
}

/**
 * Give the staged file the target's owner and group.
 *
 * Usually a no-op — the staged file is already owned by this process, which is the target's owner,
 * because anything else was refused. It matters for root, which may legitimately rewrite a file it
 * does not own and must not take it.
 */
function applyOwnership(
  descriptor: number,
  temporary: string,
  preserve: FileIdentity,
  ops: FileSystemOps,
): void {
  // No POSIX ownership to preserve. Windows carries its own ACLs, which this does not model and does
  // not claim to.
  if (ops.currentUid() === undefined) return;
  try {
    ops.fchown(descriptor, preserve.uid, preserve.gid);
  } catch (error) {
    throw new Error(
      `could not give "${temporary}" the target's owner (uid ${preserve.uid}, gid ` +
        `${preserve.gid}): ${(error as Error).message} — refusing rather than replacing the file ` +
        `with one this process owns`,
    );
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
    // The bytes about to be published, held to the same standard as the file they will replace.
    // Everything the target is checked for, the staged file is checked for too.
    assertStagedUnchanged(staged, ops);
    ops.rename(staged.temporary, staged.target);
  } catch (error) {
    throw failWith(error, discard(staged, ops));
  }
}

/** Is the staged file still the one this process wrote? */
function assertStagedUnchanged(staged: StagedFile, ops: FileSystemOps): void {
  const stat = inspect(staged.temporary, ops);
  if (!stat) {
    throw new TargetChangedError(staged.temporary, "the staged file is gone");
  }
  rejectUnreplaceable(staged.temporary, stat);
  const change = describeIdentityChange(staged.identity, identityOf(stat));
  if (change) throw new TargetChangedError(staged.temporary, `the staged file: ${change}`);
  if (sha256(ops.readBytes(staged.temporary)) !== staged.checksum) {
    throw new TargetChangedError(staged.temporary, "the staged file's contents changed");
  }
}

/**
 * Throw away a staged file, if it is still the staged file. Never throws.
 *
 * Removing by name alone would delete whatever holds that name now — which, if something replaced
 * it, is somebody else's file. The identity is what makes this a removal rather than a guess.
 */
function discard(staged: StagedFile, ops: FileSystemOps): DiscardOutcome {
  let stat: Stats | undefined;
  try {
    stat = inspect(staged.temporary, ops);
  } catch (error) {
    return { temporary: staged.temporary, removed: false, error: error as Error, notOurs: true };
  }
  if (!stat) return { temporary: staged.temporary, removed: true };
  if (describeIdentityChange(staged.identity, identityOf(stat))) {
    return {
      temporary: staged.temporary,
      removed: false,
      error: new Error("the path no longer holds the staged file, so it was left alone"),
      notOurs: true,
    };
  }
  return discardByPath(staged.temporary, ops);
}

/** Remove a path this process is known to have created, before there is an identity to check. */
function discardByPath(temporary: string, ops: FileSystemOps): DiscardOutcome {
  try {
    ops.unlink(temporary);
    return { temporary, removed: true };
  } catch (error) {
    if (isNotFound(error)) return { temporary, removed: true };
    return { temporary, removed: false, error: error as Error };
  }
}

/**
 * The error to throw when a write failed.
 *
 * The original failure is what says what went wrong, so it is never replaced. A cleanup that also
 * failed is added to it rather than dropped, because the leftover file is a thing the user now has
 * to deal with.
 */
function failWith(primary: unknown, cleanup: DiscardOutcome): unknown {
  if (cleanup.removed || !cleanup.error) return primary;
  return new StagedFileLeftBehindError(primary, cleanup.temporary, cleanup.error);
}

/** Throw away a staged file the caller has decided not to commit. Reports what was left. */
export function discardStaged(
  staged: StagedFile,
  ops: FileSystemOps = nodeFileSystem,
): DiscardOutcome {
  return discard(staged, ops);
}

/**
 * Replace a file this tool owns, in one call.
 *
 * The whole state of the target — present or absent, which inode, which mode and owner, which bytes
 * — is captured before staging and re-checked immediately before the rename. Anything that differs
 * is a refusal, because every difference is somebody else's change.
 */
export function replaceArtifact(
  path: string,
  contents: string,
  ops: FileSystemOps = nodeFileSystem,
): void {
  const before = snapshotArtifact(path, ops);
  const staged = stageReplacement(path, contents, {
    ops,
    ...(before.state === "present" ? { preserve: before.identity } : {}),
  });
  commitStaged(staged, {
    ops,
    verify: () => {
      const change = describeArtifactChange(before, snapshotArtifact(path, ops));
      if (change) throw new TargetChangedError(path, change);
    },
  });
}
