import { createHash } from "node:crypto";
import { closeSync, fsyncSync, ftruncateSync, openSync, readFileSync, writeSync } from "node:fs";

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
 */

/**
 * The filesystem calls this makes, so a test can fail one of them.
 *
 * Four functions, defaulting to `node:fs`. A partial write and a failing `fsync` are the paths that
 * decide whether a user's file survives, and there is no other way to reach them.
 */
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
}

export const nodeSourceIo: SourceIo = Object.freeze<SourceIo>({
  open: (path, flags) => openSync(path, flags),
  read: (descriptor) => readFileSync(descriptor),
  write: (descriptor, bytes, offset, length, position) =>
    writeSync(descriptor, bytes, offset, length, position),
  fsync: fsyncSync,
  close: closeSync,
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
    const before = io.read(descriptor);
    const actual = sha256(before);
    if (actual !== expectedChecksum) throw new SourceChangedError(path, expectedChecksum, actual);

    const after = Buffer.from(contents, "utf8");
    try {
      ftruncateSync(descriptor, 0);
      writeAllAt(io, descriptor, after);
      io.fsync(descriptor);
    } catch (error) {
      try {
        ftruncateSync(descriptor, 0);
        writeAllAt(io, descriptor, before);
        io.fsync(descriptor);
      } catch (restoreError) {
        throw new SourceRestoreFailedError(path, error, restoreError);
      }
      throw error;
    }

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
