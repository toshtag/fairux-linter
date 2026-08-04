import { createHash } from "node:crypto";
import {
  closeSync,
  fstatSync,
  fsyncSync,
  ftruncateSync,
  openSync,
  readFileSync,
  statSync,
  writeSync,
} from "node:fs";

/**
 * Writing a file the user is editing.
 *
 * Deliberately not the artifact writer. Replacing a source file by rename gives the name a new
 * inode, and everything attached to the old one goes with it: the symlink that pointed here becomes
 * a regular file, the hard link stops being the same file, and the mode, owner, ACL, extended
 * attributes, and — on Windows — the security descriptor all become whatever a newly created file
 * gets. A fix is supposed to change one range of bytes.
 *
 * So a fix opens the file it is fixing and writes through it, the way `prettier --write` and
 * `eslint --fix` do. The inode never changes, so none of that metadata is touched, and there is no
 * platform where this is unavailable.
 *
 * The cost is that the risky window is inside the file rather than beside it: an error partway
 * through leaves the file short. The original bytes are held and written back when that happens, and
 * a failure to restore is reported as exactly that. Power loss is not covered — no formatter's
 * in-place write covers it, and claiming otherwise would be the overstatement this project keeps
 * refusing.
 *
 * The other cost is that a descriptor outlives the name it was opened by. An editor saving
 * atomically replaces the path with a new file, and a descriptor opened before that still refers to
 * the old one — so a write through it lands on a file nothing points at any more, or, if the old
 * inode still has another hard link, on that. The path is compared against the descriptor before
 * the truncate and again after the write, which catches the ordinary editor save without a lock.
 */

/**
 * The filesystem calls this makes, so a test can fail one of them.
 *
 * Defaulting to `node:fs`. A partial write, a failing `fsync`, and a path replaced mid-write are the
 * paths that decide whether a user's file survives, and there is no other way to reach them.
 */
export interface SourceIdentity {
  readonly dev: bigint;
  readonly ino: bigint;
}

export interface SourceIo {
  readonly open: (path: string, flags: string) => number;
  readonly read: (descriptor: number) => Buffer;
  readonly write: (
    descriptor: number,
    bytes: Buffer,
    offset: number,
    length: number,
    position: number,
  ) => number;
  readonly fsync: (descriptor: number) => void;
  readonly close: (descriptor: number) => void;
  readonly identityOfDescriptor: (descriptor: number) => SourceIdentity;
  /** Throws when the path names nothing — which is itself an answer: not the file that was opened. */
  readonly identityOfPath: (path: string) => SourceIdentity;
}

export const nodeSourceIo: SourceIo = Object.freeze<SourceIo>({
  open: (path, flags) => openSync(path, flags),
  read: (descriptor) => readFileSync(descriptor),
  write: (descriptor, bytes, offset, length, position) =>
    writeSync(descriptor, bytes, offset, length, position),
  fsync: fsyncSync,
  close: closeSync,
  identityOfDescriptor: (descriptor) => fstatSync(descriptor, { bigint: true }),
  // `stat`, not `lstat`: writing through a symlink is writing to its target, and the descriptor is
  // the target's. Comparing the link's own identity would refuse every symlink.
  identityOfPath: (path) => statSync(path, { bigint: true }),
});

export function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** The file is not what the plan described. Its current checksum is carried for the report. */
export class SourceChangedError extends Error {
  constructor(
    readonly path: string,
    readonly expected: string,
    readonly actual: string,
  ) {
    super(
      `"${path}" changed since it was scanned, so the fix was computed against different bytes`,
    );
    this.name = "SourceChangedError";
  }
}

/**
 * The path stopped naming the file that was opened for this fix.
 *
 * An editor saving atomically is the ordinary way this happens: the path gets a new inode and the
 * descriptor keeps the old one. Writing through it would edit a file nothing points at — or, if the
 * old inode still has another hard link, the file under that other name.
 */
export class SourcePathChangedError extends Error {
  constructor(readonly path: string) {
    super(
      `"${path}" stopped naming the file that was opened for this fix — something replaced it, ` +
        `so nothing at that path was written`,
    );
    this.name = "SourcePathChangedError";
  }
}

/** The write failed *and* the original could not be put back. The worst outcome, named as such. */
export class SourceRestoreFailedError extends Error {
  constructor(
    readonly path: string,
    override readonly cause: unknown,
    readonly restoreError: unknown,
  ) {
    super(
      `writing "${path}" failed (${cause instanceof Error ? cause.message : String(cause)}) and ` +
        `restoring it failed too (${
          restoreError instanceof Error ? restoreError.message : String(restoreError)
        }) — the file is incomplete and needs checking by hand`,
    );
    this.name = "SourceRestoreFailedError";
  }
}

/**
 * Write every byte, at an explicit position.
 *
 * Positional rather than sequential because the descriptor's own offset is not where these bytes
 * belong. `ftruncate` does not rewind it, so a restore after a partial write would put the original
 * contents *after* however many bytes the failed write managed — a file with a hole of NULs at the
 * front, handed back to the user as "the write failed".
 */
function writeAllAt(io: SourceIo, descriptor: number, bytes: Buffer, position = 0): void {
  let offset = 0;
  while (offset < bytes.length) {
    const written = io.write(descriptor, bytes, offset, bytes.length - offset, position + offset);
    if (written <= 0) {
      throw new Error(`wrote ${offset} of ${bytes.length} bytes and stopped making progress`);
    }
    offset += written;
  }
}

/**
 * Rewrite a source file in place, if it is still the file the plan described.
 *
 * The file is opened first and read *through that descriptor*, so the bytes that are checked and the
 * bytes that are replaced are the same file. Reading the path and then opening it would be two
 * lookups with a gap between them, and an editor saving atomically in that gap would have its new
 * file truncated on the strength of the old one's checksum.
 *
 * `r+` rather than `w`: the file must already exist and be writable as a file, so a file this
 * process cannot write fails here with the operating system's own error.
 */
export function rewriteSourceInPlace(
  path: string,
  contents: string,
  expectedChecksum: string,
  io: SourceIo = nodeSourceIo,
): void {
  const descriptor = io.open(path, "r+");
  let closed = false;
  try {
    const opened = io.identityOfDescriptor(descriptor);
    /** Does the path still name the file this descriptor refers to? */
    const pathStillOurs = (): boolean => {
      try {
        const current = io.identityOfPath(path);
        return current.dev === opened.dev && current.ino === opened.ino;
      } catch {
        // Deleted, or unreadable. Either way it is not the file that was opened.
        return false;
      }
    };

    const before = io.read(descriptor);
    const actual = sha256(before);
    if (actual !== expectedChecksum) throw new SourceChangedError(path, expectedChecksum, actual);
    // Immediately before the truncate, so an editor that saved between opening this file and now is
    // caught while nothing has been written.
    if (!pathStillOurs()) throw new SourcePathChangedError(path);

    const after = Buffer.from(contents, "utf8");
    const restore = (cause: unknown): never => {
      try {
        ftruncateSync(descriptor, 0);
        writeAllAt(io, descriptor, before);
        io.fsync(descriptor);
      } catch (restoreError) {
        throw new SourceRestoreFailedError(path, cause, restoreError);
      }
      throw cause;
    };

    try {
      ftruncateSync(descriptor, 0);
      writeAllAt(io, descriptor, after);
      io.fsync(descriptor);
    } catch (error) {
      restore(error);
    }
    // And again afterwards: the write may have landed on a file the path stopped naming while it was
    // in progress. Putting the original back leaves that file as it was — the fix did not happen,
    // and it did not happen anywhere else either.
    if (!pathStillOurs()) restore(new SourcePathChangedError(path));

    // Closed here rather than in a `finally`, so a failure to close is the error a caller sees on an
    // otherwise successful write — and cannot replace the more useful error on a failed one.
    closed = true;
    io.close(descriptor);
  } catch (error) {
    if (!closed) {
      try {
        io.close(descriptor);
      } catch {
        // The error being thrown says what actually went wrong; this would only obscure it.
      }
    }
    throw error;
  }
}
