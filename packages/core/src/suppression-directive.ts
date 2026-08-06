/**
 * Inline suppression directives — accepting one finding, in the source, with an argument.
 *
 * `--suppress <file>` already accepts individual findings by fingerprint. Two things it cannot do:
 * the fingerprint changes when the markup around a finding is restructured, and the reason sits in
 * another file from the code it is about. A comment beside the line is what a linter's users expect
 * and what survives a refactor.
 *
 *     <!-- fairux-disable-next-line scarcity/scarcity-phrase -- stock count is live -->
 *     {\/* fairux-disable-next-line consent/checked-checkbox -- approved by legal for JP *\/}
 *
 * **The reason is required here too.** The file-based form refuses a blank one because a suppression
 * without an argument is a disabled rule with extra steps, and an inline form that dropped the
 * requirement would be the loophole rather than the convenience. A directive with no `--` reason is
 * refused, and refused loudly: a malformed directive that silently suppressed nothing would leave a
 * user believing a finding was accepted when it was not, which is the worse of the two failures.
 *
 * Only `fairux-disable-next-line`. There is deliberately no file-level `fairux-disable`: a whole
 * file with no findings is indistinguishable from a whole file nobody looked at, and that is the
 * state this project keeps refusing to ship.
 *
 * Browser-safe: string handling only.
 */

/** The one directive keyword. */
export const SUPPRESSION_DIRECTIVE = "fairux-disable-next-line";

/** A comment the adapter found, with the line it sits on. */
export interface DocumentComment {
  readonly text: string;
  /** 1-based, matching evidence `source.startLine`. */
  readonly startLine: number;
}

/** A directive that parsed. */
export interface SuppressionDirective {
  readonly ruleId: string;
  readonly reason: string;
  /** The line the directive sits on; it applies to the line after. */
  readonly startLine: number;
}

/** A directive that named itself but could not be used. */
export interface MalformedDirective {
  readonly startLine: number;
  readonly text: string;
  readonly reason: string;
}

export interface ParsedDirectives {
  readonly directives: readonly SuppressionDirective[];
  readonly malformed: readonly MalformedDirective[];
}

// `rule-id` then `--` then free text. The rule id shape matches the engine's: `category/name`.
const DIRECTIVE_PATTERN = new RegExp(`${SUPPRESSION_DIRECTIVE}\\s+([^\\s]+)\\s*(?:--\\s*(.*))?$`);

/**
 * Read the directives out of a document's comments.
 *
 * A comment merely *containing* the keyword is treated as a directive attempt, not ignored. Someone
 * who writes `fairux-disable-next-line` and gets nothing needs to be told why, and the alternative —
 * matching only well-formed ones — makes every typo silent.
 */
export function parseSuppressionDirectives(
  comments: readonly DocumentComment[] | undefined,
): ParsedDirectives {
  const directives: SuppressionDirective[] = [];
  const malformed: MalformedDirective[] = [];

  for (const comment of comments ?? []) {
    const text = comment.text.trim();
    if (!text.includes(SUPPRESSION_DIRECTIVE)) continue;

    const match = DIRECTIVE_PATTERN.exec(text);
    if (!match?.[1]) {
      malformed.push({
        startLine: comment.startLine,
        text,
        reason: `expected \`${SUPPRESSION_DIRECTIVE} <rule-id> -- <reason>\``,
      });
      continue;
    }
    const [, ruleId, rawReason] = match;
    const reason = (rawReason ?? "").trim();
    if (reason === "") {
      // The same refusal the file-based form makes, for the same reason: an unargued suppression is
      // a disabled rule with extra steps, and the config already disables rules.
      malformed.push({
        startLine: comment.startLine,
        text,
        reason: "no reason given — write `-- why this is accepted here` after the rule id",
      });
      continue;
    }
    directives.push({ ruleId, reason, startLine: comment.startLine });
  }

  return { directives, malformed };
}

/**
 * Which line a finding is on, for directive matching.
 *
 * The first piece of evidence carrying a source line. A finding whose evidence has no line — a Figma
 * node, a live DOM element — cannot be matched by a directive at all, and that is a property of the
 * input rather than something to approximate. `.figjson` has no comments either.
 *
 * @param finding anything with an `evidence` array
 */
export function findingSourceLine(finding: {
  readonly evidence: readonly { readonly source?: { readonly startLine?: number } }[];
}): number | undefined {
  for (const evidence of finding.evidence) {
    if (typeof evidence.source?.startLine === "number") return evidence.source.startLine;
  }
  return undefined;
}

/**
 * Re-exported, not redeclared.
 *
 * This module used to declare its own `AppliedSuppression` beside the one in `types.js`, and
 * `scan()` cast between them. Two declarations of one public shape drift the moment either is
 * edited — which is exactly what happened when the fingerprint was added to one of them, and the
 * SDK's type-parity check is what caught it. The schema lives in `types.js`; this module is its
 * implementation.
 */
export type { AppliedSuppression } from "./types.js";

import type { AppliedSuppression } from "./types.js";

/**
 * Split findings into those a directive accepts and the record of what was accepted.
 *
 * A directive on line N applies to line N+1 only. Not "the next finding", which would skip blank
 * lines and comments and quietly cover something further down; not the whole element, which a
 * comment above an opening tag would make ambiguous for everything nested inside it.
 *
 * @param findings
 * @param directives
 */
export function applySuppressionDirectives<
  T extends {
    readonly ruleId: string;
    readonly fingerprint?: string;
    readonly evidence: readonly { readonly source?: { readonly startLine?: number } }[];
  },
>(
  findings: readonly T[],
  directives: readonly SuppressionDirective[],
): { kept: T[]; applied: AppliedSuppression[]; unused: SuppressionDirective[] } {
  const kept: T[] = [];
  const applied: AppliedSuppression[] = [];
  const used = new Set<SuppressionDirective>();

  for (const finding of findings) {
    const line = findingSourceLine(finding);
    const directive =
      line === undefined
        ? undefined
        : directives.find(
            (candidate) => candidate.startLine + 1 === line && candidate.ruleId === finding.ruleId,
          );
    if (!directive) {
      kept.push(finding);
      continue;
    }
    used.add(directive);
    applied.push({
      ruleId: directive.ruleId,
      reason: directive.reason,
      line: directive.startLine,
      // Absent rather than empty when the caller passed something without one: an empty fingerprint
      // is a value a baseline would try to match, and match nothing.
      ...(finding.fingerprint ? { fingerprint: finding.fingerprint } : {}),
    });
  }

  return {
    kept,
    applied,
    // A directive covering a finding that no longer exists is one nobody will otherwise remove, and
    // it is the same signal the file-based form reports for an unmatched entry.
    unused: directives.filter((directive) => !used.has(directive)),
  };
}
