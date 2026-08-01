/**
 * Applying a remediation, as a pure function.
 *
 * No file is read, written, or hashed here. `@fairux/core` is browser-safe, so the caller supplies
 * the contents and the checksum it computed — and that is the right shape anyway: hashing belongs
 * where the I/O does, and this stays a function whose every refusal can be tested without a
 * filesystem.
 *
 * One implementation for the dry run and the write. Two paths that agree in tests and diverge in
 * practice is the classic shape of this feature going wrong, so the only difference between them is
 * whether the caller writes the result.
 */

import type { Remediation, TextEdit } from "./types.js";

/** Why a remediation was not applied. Each one is a way a file could otherwise end up wrong. */
export type RemediationRefusalCode =
  /** Not `safe`. No flag applies one of these, and none is added later. */
  | "review-required"
  /** Suggested by an AI provider. Never applied, whatever it is labelled. */
  | "ai-origin"
  /** The file changed since the scan: the checksum does not match. */
  | "file-changed"
  /** A range points outside the file. */
  | "range-outside-file"
  /** The text at the range is not what the edit expected. */
  | "expected-mismatch"
  /** Two edits cover the same characters, so applying one invalidates the other. */
  | "overlapping-edits";

export interface RemediationRefusal {
  readonly remediationId: string;
  readonly code: RemediationRefusalCode;
  readonly message: string;
}

export interface RemediationApplication {
  /** The file's contents after every applied remediation. Unchanged when none applied. */
  readonly contents: string;
  readonly applied: readonly string[];
  readonly refused: readonly RemediationRefusal[];
  /** True when `contents` differs from what was passed in. */
  readonly changed: boolean;
}

export interface ApplyRemediationOptions {
  /** The checksum the caller computed for `contents`, lowercase hex SHA-256. */
  readonly actualChecksum: string;
  /**
   * Apply `review-required` remediations too.
   *
   * There is no such option, and this comment is where a future one would be argued for. The
   * classification is the product: an escape hatch makes `safe` decorative, and the roadmap says no
   * `--unsafe` is added. Recorded here so the absence reads as a decision rather than an oversight.
   */
  readonly never?: never;
}

/** 1-based line/column to a 0-based offset. `undefined` when the position is not in the text. */
function offsetOf(contents: string, line: number, column: number): number | undefined {
  let offset = 0;
  for (let current = 1; current < line; current += 1) {
    const next = contents.indexOf("\n", offset);
    if (next === -1) return undefined;
    offset = next + 1;
  }
  const lineEnd = contents.indexOf("\n", offset);
  const limit = lineEnd === -1 ? contents.length : lineEnd;
  const target = offset + (column - 1);
  // One past the last character is a valid position: an insertion at the end of a line lands there.
  return target > limit ? undefined : target;
}

interface ResolvedEdit {
  readonly start: number;
  readonly end: number;
  readonly replacement: string;
}

function resolveEdit(contents: string, edit: TextEdit): ResolvedEdit | RemediationRefusalCode {
  const start = offsetOf(contents, edit.startLine, edit.startColumn);
  const end = offsetOf(contents, edit.endLine, edit.endColumn);
  if (start === undefined || end === undefined || end < start) return "range-outside-file";
  if (contents.slice(start, end) !== edit.expected) return "expected-mismatch";
  return { start, end, replacement: edit.replacement };
}

function overlaps(edits: readonly ResolvedEdit[]): boolean {
  const sorted = [...edits].sort((left, right) => left.start - right.start);
  for (let index = 1; index < sorted.length; index += 1) {
    const previous = sorted[index - 1] as ResolvedEdit;
    const current = sorted[index] as ResolvedEdit;
    if (current.start < previous.end) return true;
  }
  return false;
}

function refuse(
  remediation: Remediation,
  code: RemediationRefusalCode,
  message: string,
): RemediationRefusal {
  return Object.freeze({ remediationId: remediation.id, code, message });
}

/**
 * Apply every remediation that can be applied, and report every one that cannot.
 *
 * A remediation is all-or-nothing: if any of its edits is refused, none of it is applied. A partially
 * applied fix is worse than an unapplied one, because the file is now in a state neither the author
 * nor the tool intended and nothing says so.
 *
 * Remediations are considered in order and each is checked against the contents as they stand, so a
 * second remediation touching text the first rewrote is refused by its own `expected` rather than
 * silently landing on different bytes.
 */
export function applyRemediations(
  contents: string,
  remediations: readonly Remediation[],
  options: ApplyRemediationOptions,
): RemediationApplication {
  const applied: string[] = [];
  const refused: RemediationRefusal[] = [];
  let current = contents;

  for (const remediation of remediations) {
    if (remediation.origin === "ai") {
      // Checked before safety, and separately from it: validation already refuses a `safe` AI
      // remediation, so reaching here means something built one outside that path. It is still not
      // applied, and the reason names what it actually was.
      refused.push(
        refuse(remediation, "ai-origin", "suggested by an AI provider, which is never applied"),
      );
      continue;
    }
    if (remediation.safety !== "safe") {
      refused.push(
        refuse(remediation, "review-required", "needs review, and no flag applies one of these"),
      );
      continue;
    }
    if (remediation.fileChecksum !== options.actualChecksum) {
      // Against the contents as they were passed in, not as they now stand: a remediation is valid
      // for the bytes it was computed against, and an earlier applied fix does not make a stale one
      // fresh.
      refused.push(
        refuse(
          remediation,
          "file-changed",
          "the file changed since the scan, so this edit was computed against different bytes",
        ),
      );
      continue;
    }

    const resolved: ResolvedEdit[] = [];
    let failure: RemediationRefusalCode | undefined;
    for (const edit of remediation.edits) {
      const result = resolveEdit(current, edit);
      if (typeof result === "string") {
        failure = result;
        break;
      }
      resolved.push(result);
    }
    if (failure === "range-outside-file") {
      refused.push(refuse(remediation, failure, "an edit points outside the file"));
      continue;
    }
    if (failure === "expected-mismatch") {
      refused.push(
        refuse(remediation, failure, "the text at an edit's range is not what it expected"),
      );
      continue;
    }
    if (overlaps(resolved)) {
      refused.push(
        refuse(remediation, "overlapping-edits", "two of its edits cover the same characters"),
      );
      continue;
    }

    // Right to left, so an earlier edit's offsets are still valid after a later one is applied.
    const ordered = [...resolved].sort((left, right) => right.start - left.start);
    let next = current;
    for (const edit of ordered) {
      next = next.slice(0, edit.start) + edit.replacement + next.slice(edit.end);
    }
    current = next;
    applied.push(remediation.id);
  }

  return Object.freeze({
    contents: current,
    applied: Object.freeze(applied),
    refused: Object.freeze(refused),
    changed: current !== contents,
  });
}
