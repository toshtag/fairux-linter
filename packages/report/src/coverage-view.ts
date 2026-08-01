import type { CapabilityId, RuleSkipReason, ScanCoverage } from "@fairux/core";

/**
 * The one derivation every human-facing format shares.
 *
 * Markdown and HTML escape differently and lay out differently, but "which rules did not run, and
 * why" is the same question in both. Deriving it once keeps the three formats from disagreeing about
 * an answer the report already contains.
 */

/** What a reader is told a skip reason means. Not the enum value — that is for machines. */
const REASON_LABEL: Record<RuleSkipReason, string> = {
  "not-enabled": "Not enabled by this configuration",
  "missing-capability": "This input cannot supply what they require",
  "page-context-mismatch": "Scoped to a page context this input does not match",
};

/** Fixed order, so two runs of the same scan render identically. */
const REASON_ORDER: readonly RuleSkipReason[] = [
  "missing-capability",
  "page-context-mismatch",
  "not-enabled",
];

export interface SkippedRuleView {
  readonly ruleId: string;
  /** Only for `missing-capability`; empty otherwise. */
  readonly missingCapabilities: readonly CapabilityId[];
}

export interface SkippedGroupView {
  readonly reason: RuleSkipReason;
  readonly label: string;
  readonly rules: readonly SkippedRuleView[];
}

export interface DegradedRuleView {
  readonly ruleId: string;
  readonly missingOptionalCapabilities: readonly CapabilityId[];
}

export interface CoverageView {
  readonly available: readonly CapabilityId[];
  readonly unavailable: readonly CapabilityId[];
  /** "9 of 13 rules ran" as its parts. Never divided — a ratio here is the score this is not. */
  readonly counts: ScanCoverage["summary"];
  /** Non-empty groups only, in `REASON_ORDER`. */
  readonly skipped: readonly SkippedGroupView[];
  /** Rules that ran without an optional capability. */
  readonly degraded: readonly DegradedRuleView[];
}

export function toCoverageView(coverage: ScanCoverage): CoverageView {
  const skipped: SkippedGroupView[] = [];
  for (const reason of REASON_ORDER) {
    const rules = coverage.rules
      .filter((entry) => !entry.executed && entry.skipReason === reason)
      .map((entry) => ({
        ruleId: entry.ruleId,
        missingCapabilities: entry.missingCapabilities ?? [],
      }));
    if (rules.length > 0) skipped.push({ reason, label: REASON_LABEL[reason], rules });
  }

  return {
    available: coverage.capabilities.available,
    unavailable: coverage.capabilities.unavailable,
    counts: coverage.summary,
    skipped,
    degraded: coverage.rules
      .filter((entry) => entry.executed && (entry.missingOptionalCapabilities?.length ?? 0) > 0)
      .map((entry) => ({
        ruleId: entry.ruleId,
        missingOptionalCapabilities: entry.missingOptionalCapabilities ?? [],
      })),
  };
}

/**
 * Printed with the coverage of every human-facing report.
 *
 * The numbers beside it are one division away from a score, and a score is what the reader will
 * reach for. This says, in the same place, what the counts do not mean.
 */
export const COVERAGE_NOTE =
  "Coverage says which rules ran, not whether they were right. It is not a score, and no findings " +
  "is not a statement that this is fair or compliant.";

/** "none" rather than an empty line: a blank list reads as an omission. */
export function orNone(values: readonly string[]): string {
  return values.length > 0 ? values.join(", ") : "none";
}
