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
  /**
   * Two edits cover the same characters, so applying one invalidates the other.
   *
   * Two *identical* edits are this too, and deliberately not a code of their own: a duplicate covers
   * exactly the characters the edit it duplicates covers, which is the sentence this code already
   * says. A second name for one condition is a second thing every consumer has to learn to handle.
   */
  | "overlapping-edits";

export interface RemediationRefusal {
  readonly remediationId: string;
  readonly code: RemediationRefusalCode;
  readonly message: string;
}

/**
 * A remediation that asked for a change an earlier one had already made, character for character.
 *
 * A third outcome, deliberately not a refusal. Two rules can reach the same conclusion about the
 * same attribute — a built-in rule and a RulePack both removing one `checked` — and the second is
 * not wrong, stale, or in conflict: what it asked for is in the file. Reporting it under `refused`
 * would make the CLI exit 1 on a tree that is exactly what was asked for, which is what this type
 * exists to stop, and it would put it in the same bucket as the refusals that protect a file.
 */
export interface RemediationCoalescence {
  readonly remediationId: string;
  /**
   * The remediation that made the identical edit.
   *
   * The **first** one, when a multi-edit remediation was satisfied by more than one — every edit had
   * to be matched for this to be reported at all, so the others are named on their own lines and
   * nothing goes unaccounted for. Every remediation this repository produces carries one edit.
   */
  readonly satisfiedBy: string;
}

export interface RemediationApplication {
  /** The file's contents after every applied remediation. Unchanged when none applied. */
  readonly contents: string;
  readonly applied: readonly string[];
  /**
   * Remediations every one of whose edits an earlier remediation had already made identically.
   *
   * Accounted for rather than dropped: a caller must be able to say which remediation covered which,
   * and "nothing happened" is not the same answer as "somebody else did it".
   */
  readonly coalesced: readonly RemediationCoalescence[];
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

/**
 * Whether a remediation contradicts itself, judged without looking at the file.
 *
 * Both answers here are properties of the remediation alone: two edits that cover the same
 * characters cannot both be applied, and two edits that are character-for-character the same are a
 * request whose meaning is undefined — once, or twice?
 *
 * It has to be asked *before* coalescing, and that is the whole point of the function. Coalescing
 * matches a remediation's edits against edits an earlier one already made, so a remediation with
 * two identical edits matched on one key and was waved through as "already satisfied" — never
 * resolved, never checked, and reported as accounted for. A self-overlapping remediation went the
 * same way whenever the overlap was inside a range somebody else had already written. The malformed
 * remediation was invisible precisely when another rule happened to agree with part of it.
 *
 * Positions rather than offsets, because no file is needed to answer it: a remediation carrying
 * these edits is wrong against every file, including one it could never be resolved against.
 *
 * An edit whose own end precedes its own start is left alone here. That is `range-outside-file`, and
 * it is {@link resolveEdit}'s to report — sorting such a span would make it look like an overlap and
 * a reader would be told the wrong thing about it.
 */
function selfConflict(
  contents: string,
  remediation: Remediation,
): RemediationRefusalCode | undefined {
  const resolved: ResolvedEdit[] = [];
  for (const edit of remediation.edits) {
    // Against `contents` — the bytes as the scan saw them — and never against the file as it now
    // stands. That is the only version this remediation makes a claim about: `fileChecksum` attests
    // to it, and a mismatch is refused before this is reached. Judging against the current text
    // would make a remediation's validity depend on what an unrelated earlier one happened to
    // write, which is the coupling coalescing exists to remove.
    const result = resolveEdit(contents, edit);
    // A range that is not in the scan-time file, or text that is not what the edit expected, is
    // wrong on the remediation's own terms — before anyone asks whether somebody else made the
    // same edit.
    if (typeof result === "string") return result;
    resolved.push(result);
  }

  const sorted = [...resolved].sort(
    (left, right) => left.start - right.start || left.end - right.end,
  );
  for (let index = 1; index < sorted.length; index += 1) {
    const previous = sorted[index - 1] as ResolvedEdit;
    const current = sorted[index] as ResolvedEdit;
    if (current.start < previous.end) return "overlapping-edits";
    // Two edits over the same non-empty span: a duplicate, or two different replacements for one
    // range. Both are "cover the same characters". Two *empty* ranges at one position are two
    // insertions, which compose, so they are left alone.
    if (
      current.start === previous.start &&
      current.end === previous.end &&
      current.end > current.start
    ) {
      return "overlapping-edits";
    }
  }
  return undefined;
}

/**
 * One sentence per refusal code, so the same condition reads the same wherever it is reported.
 *
 * The self-check and the application path can both reach `range-outside-file` and
 * `expected-mismatch` — the first against the scan-time bytes, the second against the file as it
 * stands — and two hand-written wordings for one code is how a consumer ends up matching on prose
 * instead of on the code beside it.
 */
const REFUSAL_MESSAGE: Readonly<Record<RemediationRefusalCode, string>> = Object.freeze({
  "review-required": "needs review, and no flag applies one of these",
  "ai-origin": "suggested by an AI provider, which is never applied",
  "file-changed":
    "the file changed since the scan, so this edit was computed against different bytes",
  "range-outside-file": "an edit points outside the file",
  "expected-mismatch": "the text at an edit's range is not what it expected",
  "overlapping-edits": "two of its edits cover the same characters",
});

function refuse(
  remediation: Remediation,
  code: RemediationRefusalCode,
  message: string = REFUSAL_MESSAGE[code],
): RemediationRefusal {
  return Object.freeze({ remediationId: remediation.id, code, message });
}

/**
 * When two edits are the same edit.
 *
 * Every part of what an edit *is* has to match: the file it names, the checksum of the bytes it was
 * computed against, where in those bytes it starts and ends, what it expected to find there, and
 * what it puts back. Nothing about the file as it now stands is consulted — the question is whether
 * two remediations asked for the same thing, not whether the answer happens to look right
 * afterwards. A file that already contained a plausible value is exactly what `expected` exists to
 * catch, and this must not become a way around it.
 *
 * The checksum is in the key *and* a mismatch is refused before this is reached, and neither is
 * decoration: removing either alone leaves the other holding, and removing both lets a stale
 * remediation be coalesced by an identical fresh one. The file is in the key because nothing else
 * enforces it — one call is one file's contents by convention, not by a check here.
 */
function editIdentity(remediation: Remediation, edit: TextEdit): string {
  return JSON.stringify([
    remediation.file,
    remediation.fileChecksum,
    edit.startLine,
    edit.startColumn,
    edit.endLine,
    edit.endColumn,
    edit.expected,
    edit.replacement,
  ]);
}

/**
 * The remediation that already made every one of these edits, or `undefined`.
 *
 * **Every** one. A remediation with two edits, one of which an earlier remediation made, is not
 * satisfied — half of what it asked for has not happened, and applying the rest would put the other
 * half through a range whose text has moved. That is the partial-overlap case, and it stays a
 * refusal.
 *
 * Attributed to the first remediation that made one of them, so a reader is told who covered it
 * rather than only that somebody did. When two earlier remediations covered one each, the first is
 * named — both are on their own lines, having been applied.
 */
function alreadySatisfiedBy(
  remediation: Remediation,
  appliedEdits: ReadonlyMap<string, string>,
): string | undefined {
  if (remediation.edits.length === 0) return undefined;
  let first: string | undefined;
  for (const edit of remediation.edits) {
    const by = appliedEdits.get(editIdentity(remediation, edit));
    if (by === undefined) return undefined;
    first ??= by;
  }
  return first;
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
 *
 * One case is not that, and used to be treated as it. Two rules can reach the same conclusion about
 * the same attribute — a built-in rule and a RulePack both removing one `checked` — and the second
 * remediation's range then holds text the first replaced, so it was refused as `expected-mismatch`
 * and made `--fix-write` exit 1 on a file that was exactly what was asked for. A remediation whose
 * every edit an earlier one already made *identically* is now coalesced instead: one physical edit,
 * both remediations accounted for, and no failure.
 *
 * Identical means identical — see {@link editIdentity}. The comparison is between what the two
 * remediations asked for, never between one of them and the file as it now stands, so a file that
 * happened to contain a plausible value is still caught by `expected`.
 */
export function applyRemediations(
  contents: string,
  remediations: readonly Remediation[],
  options: ApplyRemediationOptions,
): RemediationApplication {
  const applied: string[] = [];
  const coalesced: RemediationCoalescence[] = [];
  const refused: RemediationRefusal[] = [];
  /** Edits that physically landed, by identity, to the remediation that made them. */
  const appliedEdits = new Map<string, string>();
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

    // Before coalescing, because a remediation that contradicts itself is wrong whatever anyone
    // else did — and coalescing is exactly what used to hide it: two identical edits match on one
    // key, so a remediation nobody could have applied was reported as already satisfied.
    const conflict = selfConflict(contents, remediation);
    if (conflict !== undefined) {
      refused.push(refuse(remediation, conflict, REFUSAL_MESSAGE[conflict]));
      continue;
    }

    // After the three refusals above and before anything is resolved. After, because an AI-origin,
    // a review-required, and a stale-checksum remediation are refusals whatever anyone else did —
    // coalescing one would be a way around a boundary rather than an accounting fix. Before, because
    // the resolution this skips is exactly the one that would fail: the range holds the text the
    // earlier edit put there.
    const satisfiedBy = alreadySatisfiedBy(remediation, appliedEdits);
    if (satisfiedBy !== undefined) {
      coalesced.push(Object.freeze({ remediationId: remediation.id, satisfiedBy }));
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
    // No second overlap check here. `selfConflict` already answered it from the positions, and a
    // position maps to exactly one offset, so a post-resolution check could never fire — a branch
    // no test can reach is a claim nobody can verify.

    // Right to left, so an earlier edit's offsets are still valid after a later one is applied.
    const ordered = [...resolved].sort((left, right) => right.start - left.start);
    let next = current;
    for (const edit of ordered) {
      next = next.slice(0, edit.start) + edit.replacement + next.slice(edit.end);
    }
    current = next;
    applied.push(remediation.id);
    // Recorded only for edits that physically landed, so a later remediation identical to a
    // *refused* one is judged on its own rather than waved through by one that never happened.
    for (const edit of remediation.edits) {
      appliedEdits.set(editIdentity(remediation, edit), remediation.id);
    }
  }

  return Object.freeze({
    contents: current,
    applied: Object.freeze(applied),
    coalesced: Object.freeze(coalesced),
    refused: Object.freeze(refused),
    changed: current !== contents,
  });
}
