import { closeSync, fsyncSync, openSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

/**
 * Replace a file's contents, or leave the file as it was.
 *
 * `writeFileSync` truncates first and then writes, so a process killed between the two leaves an
 * empty or half-written file where a valid one used to be. For a baseline that is a build's record
 * of accepted risk and for a Risk Index that a pipeline reads, the truncated state is worse than
 * either the old contents or the new ones: it is a file that parses as nothing.
 *
 * Writing to a temporary file in the same directory and renaming over the target moves the failure
 * window to a place where nothing is lost — a crash before the rename leaves the original intact and
 * a stray temp file behind, and the rename itself is atomic within a filesystem. Same directory
 * because a rename across filesystems is a copy, which is the non-atomic operation this avoids.
 *
 * This is not a transaction across files. Writing two outputs is two renames, and a crash between
 * them leaves one updated and one not. What is guaranteed is per-file: no reader ever sees a partial
 * document, and a failed write does not destroy what was there.
 */

let counter = 0;

export function writeFileAtomic(filePath: string, contents: string): void {
  const target = resolve(filePath);
  const directory = dirname(target);
  // Dotted and pid-tagged, so two concurrent runs do not pick the same name and a leftover is
  // recognisable as ours rather than as something the user wrote.
  counter += 1;
  const temporary = join(directory, `.${basename(target)}.${process.pid}.${counter}.tmp`);

  let descriptor: number | undefined;
  try {
    // `wx` fails rather than overwriting: if this name somehow exists, it is not ours to truncate.
    descriptor = openSync(temporary, "wx");
    writeSync(descriptor, contents, null, "utf8");
    // Before the rename, so the rename does not publish a name whose contents are still in a buffer
    // the kernel has not written. Without it, a crash can leave a correctly-named empty file, which
    // is the failure this whole function exists to prevent.
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporary, target);
  } catch (error) {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        // Already closed, or never usable. The unlink below is what matters.
      }
    }
    try {
      unlinkSync(temporary);
    } catch {
      // Never created, or already gone. Failing to clean up must not replace the real error.
    }
    throw error;
  }
}
