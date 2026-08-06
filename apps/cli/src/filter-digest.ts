import { createHash } from "node:crypto";

/**
 * The identity of a filter file's contents, as opposed to its name.
 *
 * `--baseline .fairux-baseline.json` names the same path on every run of a repository's CI for
 * years. What it names is not the same file: entries are added when a team accepts something, and
 * the report gets shorter with nothing in the artifact changing except the numbers. A reader
 * comparing two runs can see the counts move and cannot see why.
 *
 * Hashing the bytes that were parsed — not a re-read of the path — keeps the digest describing the
 * file the run actually applied. Reading twice would leave a window in which the two differ, which
 * is the exact failure the digest exists to make visible.
 */
export function digestOf(text: string): string {
  return `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;
}
