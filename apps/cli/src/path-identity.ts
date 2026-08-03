import { realpathSync, statSync } from "node:fs";
import { basename, dirname, resolve, sep } from "node:path";

/**
 * Whether two paths name the same file, and refusing to write when they do.
 *
 * A scan reads files a user cares about and, with `--write-baseline` or `--risk-index`, writes files
 * a user asked for. Nothing stopped those from being the same file, so `fairux scan page.html
 * --write-baseline page.html` replaced the page with JSON and exited 0. The loss is silent and total:
 * the input is gone, and the thing that overwrote it reports success.
 *
 * Comparing the strings is not enough. `./page.html`, `page.html`, an absolute path, a symlink, and a
 * hard link are five spellings of one file, and a check that only caught the first would read as
 * protection while providing none.
 */

/** One path a run will touch, with the flag or argument that named it. */
export interface PathRole {
  readonly path: string;
  /** What a user typed, so the refusal can name it: `"--baseline"`, `"the scanned file"`. */
  readonly label: string;
}

/**
 * A path reduced to something comparable.
 *
 * `canonical` is always present. `dev`/`ino` are present only for paths that exist — they are what
 * catches a hard link, which no amount of path normalisation can see, because two hard links to one
 * file are genuinely two different paths.
 */
interface PathIdentity {
  readonly canonical: string;
  readonly dev?: number;
  readonly ino?: number;
}

/**
 * Case-insensitive comparison on the platforms whose filesystems usually are.
 *
 * Only reached for paths where at least one side does not exist — an existing pair is settled by
 * inode, which is exact. So the cost of being wrong here is refusing a write on a case-sensitive
 * macOS volume where two outputs differ only by case, which is a refusal a user can work around by
 * renaming, and the failure it prevents is a file that cannot be recovered at all.
 */
function normalizeCase(path: string): string {
  return process.platform === "win32" || process.platform === "darwin" ? path.toLowerCase() : path;
}

/**
 * Resolve a path as far as the filesystem allows.
 *
 * An output file usually does not exist yet, so `realpathSync` on it would throw. Its *parent*
 * normally does, and resolving that plus the basename is what makes `./out/../out/x.json` and
 * `out/x.json` compare equal. Walking up rather than assuming one missing level keeps
 * `--risk-index a/b/c.json` comparable when neither `a` nor `b` exists yet.
 */
function canonicalize(path: string): string {
  const absolute = resolve(path);
  let current = absolute;
  const trailing: string[] = [];
  while (true) {
    try {
      return [realpathSync(current), ...trailing].join(sep);
    } catch {
      const parent = dirname(current);
      // The root does not resolve, so there is nothing left to try: compare the absolute path.
      if (parent === current) return absolute;
      trailing.unshift(basename(current));
      current = parent;
    }
  }
}

function identify(path: string): PathIdentity {
  const canonical = canonicalize(path);
  try {
    const stat = statSync(path);
    // `ino` is 0 on filesystems that do not report one; treating that as an identity would make
    // every such file identical to every other.
    if (stat.ino !== 0) return { canonical, dev: stat.dev, ino: stat.ino };
  } catch {
    // Does not exist, or cannot be stat'd. The canonical path is the whole answer.
  }
  return { canonical };
}

function sameFile(left: PathIdentity, right: PathIdentity): boolean {
  if (
    left.ino !== undefined &&
    right.ino !== undefined &&
    left.dev === right.dev &&
    left.ino === right.ino
  ) {
    return true;
  }
  return normalizeCase(left.canonical) === normalizeCase(right.canonical);
}

/** A write that would have destroyed something. Carries both sides so the message can name them. */
export class OutputCollisionError extends Error {
  constructor(
    readonly writeLabel: string,
    readonly writePath: string,
    readonly otherLabel: string,
    readonly otherPath: string,
  ) {
    super(
      `${writeLabel} would write to ${otherLabel} ("${writePath}"` +
        (writePath === otherPath ? "" : ` is "${otherPath}"`) +
        ") — refusing, because that file would be destroyed",
    );
    this.name = "OutputCollisionError";
  }
}

/**
 * Refuse before anything is scanned or written.
 *
 * Every output is compared against every input and against every other output, in one pass, because
 * a check that ran per-write would let the first write land before the second was refused — and the
 * first write is the destructive one.
 *
 * Files a fix rewrites are deliberately not passed here: `--fix-write` edits the scanned file on
 * purpose, and that is the one case where writing to an input is the whole point.
 */
export function assertNoOutputCollisions(
  reads: readonly PathRole[],
  writes: readonly PathRole[],
): void {
  if (writes.length === 0) return;

  const writeIdentities = writes.map((role) => ({ role, identity: identify(role.path) }));

  for (let index = 0; index < writeIdentities.length; index += 1) {
    const write = writeIdentities[index] as (typeof writeIdentities)[number];

    for (const read of reads) {
      const readIdentity = identify(read.path);
      if (sameFile(write.identity, readIdentity)) {
        throw new OutputCollisionError(write.role.label, write.role.path, read.label, read.path);
      }
    }

    // Against later outputs only: comparing both directions would report the same pair twice, and
    // the first report is the one that stops the run anyway.
    for (const other of writeIdentities.slice(index + 1)) {
      if (sameFile(write.identity, other.identity)) {
        throw new OutputCollisionError(
          write.role.label,
          write.role.path,
          other.role.label,
          other.role.path,
        );
      }
    }
  }
}
