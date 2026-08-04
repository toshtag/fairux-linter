import { randomBytes } from "node:crypto";
import {
  closeSync,
  fchmodSync,
  fsyncSync,
  openSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

/**
 * Writing a file this tool owns: a baseline, a Risk Index.
 *
 * The caller named the path and expects it replaced, so replacing it is the whole job. What must not
 * happen is an interrupted write leaving a truncated file where a valid one was — `writeFileSync`
 * truncates before it writes, so a crash between the two destroys the old version without producing
 * the new one. Writing beside the target and renaming moves that window somewhere harmless.
 *
 * What this does *not* do is treat the output as contested. A path a user asked to be written is
 * theirs to lose; the file that must not be lost is the one they asked to be *read*, and that is the
 * collision check's job, in `path-identity.ts`, before any of this runs.
 */

/** Failure while replacing an artifact. Names the leftover file when there is one. */
export class ArtifactWriteError extends Error {
  constructor(
    readonly path: string,
    override readonly cause: unknown,
    readonly leftover?: string,
  ) {
    super(
      `could not write "${path}": ${cause instanceof Error ? cause.message : String(cause)}` +
        (leftover ? ` (a temporary file may remain at "${leftover}")` : ""),
    );
    this.name = "ArtifactWriteError";
  }
}

/** The mode of an existing file, so replacing it does not widen who can read it. */
function existingMode(path: string): number | undefined {
  try {
    const stat = statSync(path);
    return stat.isFile() ? stat.mode & 0o7777 : undefined;
  } catch {
    return undefined;
  }
}

/** Write every byte. `write` may take fewer than it was given, and one call is not the whole write. */
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
 * Replace an artifact, or leave the existing one alone.
 *
 * The temporary file goes in the target's own directory, because a rename across filesystems is a
 * copy — the non-atomic operation this exists to avoid.
 */
export function writeArtifact(filePath: string, contents: string): void {
  const target = resolve(filePath);
  const mode = existingMode(target);
  const temporary = join(
    dirname(target),
    `.${basename(target)}.${randomBytes(6).toString("hex")}.fairux-tmp`,
  );

  let descriptor: number | undefined;
  let created = false;
  try {
    descriptor = openSync(temporary, "wx", 0o600);
    created = true;
    writeAll(descriptor, Buffer.from(contents, "utf8"));
    // The mode it will have, applied before it is published under the target's name rather than
    // after — a baseline a user restricted to themselves should not come back world-readable.
    if (mode !== undefined) fchmodSync(descriptor, mode);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporary, target);
  } catch (error) {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        // Already closed, or never usable.
      }
    }
    // Only when the open succeeded. Telling a user to check for a file that was never created —
    // which is every failure to open one — sends them looking for something that is not there.
    let leftover: string | undefined;
    if (created) {
      leftover = temporary;
      try {
        unlinkSync(temporary);
        leftover = undefined;
      } catch {
        // Best effort. If it could not be removed, the error below names it.
      }
    }
    throw new ArtifactWriteError(target, error, leftover);
  }
}
