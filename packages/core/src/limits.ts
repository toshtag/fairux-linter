/**
 * DoS resistance limits.
 *
 * The linter reads untrusted input files (HTML/JSX/TSX) and builds an in-memory
 * node tree. Without limits, a huge or deeply-nested input can OOM or
 * stack-overflow the process. These constants cap input size, node count, and
 * tree depth — surfaces a clean error instead of a crash.
 */

/** Maximum input file size in bytes (10 MB). */
export const MAX_INPUT_BYTES = 10 * 1024 * 1024;

/** Maximum number of UI nodes in a single document (50 000). */
export const MAX_NODE_COUNT = 50_000;

/** Maximum tree depth (500 levels). */
export const MAX_TREE_DEPTH = 500;

export class InputTooLargeError extends Error {
  constructor(
    public readonly limit: number,
    public readonly actual: number,
    public readonly kind: "bytes" | "nodes" | "depth",
  ) {
    const unit = kind === "bytes" ? "bytes" : kind === "nodes" ? "nodes" : "levels";
    super(
      `fairux: input exceeds ${kind} limit (${actual} ${unit} > ${limit} ${unit}). ` +
        `The file is too large or deeply nested to scan safely.`,
    );
    this.name = "InputTooLargeError";
  }
}
