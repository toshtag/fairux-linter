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
 * The cost is that the window is inside the file rather than beside it: an error partway through
 * leaves the file short. The original bytes are held in memory and written back when that happens,
 * and a failure to restore is reported as exactly that. Power loss is not covered — no formatter
 * covers it, and claiming otherwise would be the overstatement this project keeps refusing.
 */

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
        }) — the file may be incomplete`,
    );
    this.name = "SourceRestoreFailedError";
  }
}

function writeAll(descriptor: number, bytes: Buffer): void {
  let offset = 0;
  while (offset < bytes.length) {
    const written = writeSync(descriptor, bytes, offset, bytes.length - offset);
    if (written <= 0) {
      throw new Error(`wrote ${offset} of ${bytes.length} bytes and stopped making progress`);
    }
    offset += written;
  }
}

/**
 * Rewrite a source file in place, if it is still the file the plan described.
 *
 * The current bytes are read once — the same read that proves the checksum and the same one held for
 * a restore. Opening with `r+` rather than `w` means a file this process cannot write fails here,
 * with the operating system's own error, rather than being replaced through a directory it happens
 * to be allowed to write.
 */
export function rewriteSourceInPlace(
  path: string,
  contents: string,
  expectedChecksum: string,
): void {
  const before = readFileSync(path);
  const actual = sha256(before);
  if (actual !== expectedChecksum) throw new SourceChangedError(path, expectedChecksum, actual);

  const after = Buffer.from(contents, "utf8");
  // `r+`: the file must already exist and be writable as a file. `w` would create or truncate it,
  // which turns "I cannot write this" into "I have destroyed this".
  const descriptor = openSync(path, "r+");
  try {
    ftruncateSync(descriptor, 0);
    writeAll(descriptor, after);
    fsyncSync(descriptor);
  } catch (error) {
    try {
      ftruncateSync(descriptor, 0);
      writeAll(descriptor, before);
      fsyncSync(descriptor);
    } catch (restoreError) {
      throw new SourceRestoreFailedError(path, error, restoreError);
    }
    throw error;
  } finally {
    closeSync(descriptor);
  }
}
