import type { RiskIndexReport } from "@fairux/core";

/**
 * The one place a surface asks what a Risk Index may display.
 *
 * Every renderer reads this rather than the report, because a renderer is where the invariant gets
 * lost: one surface printing `0` for a null score undoes the whole contract, and the mistake is
 * invisible in a screenshot. Here it is impossible — `score` is a string only when the report
 * carries a number, and the placeholder is a dash rather than a digit.
 */

export interface RiskIndexView {
  /** The score as text, or `null` when there is none. Never a stand-in value. */
  readonly score: string | null;
  /** What to show where a score would be. Never numeric. */
  readonly scorePlaceholder: string;
  readonly status: RiskIndexReport["status"];
  readonly statusLabel: string;
  /** Present exactly when there is no score. */
  readonly reason?: string | undefined;
  readonly modelVersion: string;
  readonly confidence: string;
  readonly coverage: {
    readonly documents: number;
    readonly journeySteps?: number;
    readonly requiredCapabilities: readonly string[];
    readonly missingCapabilities: readonly string[];
    readonly rules: RiskIndexReport["coverage"]["rules"];
  };
  readonly contributingFindingCount: number;
  readonly limitations: readonly string[];
}

const STATUS_LABEL: Record<RiskIndexReport["status"], string> = {
  sufficient: "Scored",
  "insufficient-coverage": "Not scored — coverage was not enough",
  unsupported: "Not scored — no model applies",
};

/** Shown where a number would be. A dash, because every numeric stand-in gets quoted as a score. */
const NO_SCORE = "—";

export function toRiskIndexView(report: RiskIndexReport): RiskIndexView {
  const scored = report.status === "sufficient" && report.score !== null;
  return {
    // The one condition. A report with a score it should not have would still not print one, and a
    // renderer cannot reach past this to the raw field without failing its own test.
    score: scored ? String(report.score) : null,
    scorePlaceholder: NO_SCORE,
    status: report.status,
    statusLabel: STATUS_LABEL[report.status],
    ...(scored ? {} : { reason: report.reason?.message ?? "no reason recorded" }),
    modelVersion: report.versions.modelVersion ?? "none",
    confidence: scored && report.confidence ? report.confidence : NO_SCORE,
    coverage: {
      documents: report.coverage.documents,
      ...(report.coverage.journeySteps !== undefined
        ? { journeySteps: report.coverage.journeySteps }
        : {}),
      requiredCapabilities: report.coverage.requiredCapabilities,
      missingCapabilities: report.coverage.missingCapabilities,
      rules: report.coverage.rules,
    },
    contributingFindingCount: report.contributingFindings.length,
    limitations: report.limitations,
  };
}
