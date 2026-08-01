import type {
  Confidence,
  ContributingFinding,
  RiskIndexModel,
  RiskIndexModelInput,
  RiskIndexModelResult,
  Severity,
} from "@fairux/core";

/**
 * `fairux-risk/1` — the first Risk Index model.
 *
 * Not the best formula. The first one, chosen so a reader can predict what it will do without
 * running it: each finding contributes its severity weight, damped by how certain the detection was,
 * and the worst single input decides the score.
 *
 * Every constant below is a product claim, and each one carries the sentence that argues for it. A
 * constant that cannot be argued for in a sentence does not belong in a formula this visible.
 */

export const RISK_MODEL_VERSION = "fairux-risk/1";

/**
 * What one finding of each severity is worth.
 *
 * The ratios are the claim: one high-severity finding is worth two mediums, a medium is worth two
 * lows, and an info-level finding registers without moving much. That mirrors the severity ladder
 * the rules already use and the SARIF levels they map to (high → error, medium → warning, low and
 * info → note), so the index cannot disagree with the report it came from about which finding
 * mattered more.
 *
 * Doubling per step rather than something gentler because the alternative — many small findings
 * outweighing one serious one — is the failure mode a risk number is most often criticised for.
 */
export const SEVERITY_WEIGHTS: Readonly<Record<Severity, number>> = Object.freeze({
  high: 20,
  medium: 10,
  low: 5,
  info: 2,
});

/**
 * How much detection certainty damps a finding's contribution.
 *
 * Confidence is a property of the evidence rather than of team policy — it is deliberately not
 * overridable in `fairux.config.*` — so it is the one signal here that a scanned site cannot tune.
 * A low-confidence finding still counts, at roughly a third: dropping it would hide real risk, and
 * counting it fully would let a heuristic match weigh as much as a checked one.
 */
export const CONFIDENCE_FACTORS: Readonly<Record<Confidence, number>> = Object.freeze({
  high: 1,
  medium: 0.6,
  low: 0.3,
});

/** The scale. 0–100 because the number is read by people, and a cap because a page can only be so bad. */
export const MAX_SCORE = 100;

/**
 * Where the score saturates.
 *
 * At these weights, 100 is reached by five high-confidence high-severity findings on one page. A
 * page with five of those is not meaningfully safer than one with eight, and pretending to
 * distinguish them would be false precision. Saturation is stated as a limitation rather than
 * hidden by a curve with another constant in it.
 */
function capped(total: number): number {
  return Math.min(MAX_SCORE, Math.round(total));
}

export interface RiskModelParameters {
  readonly version: string;
  readonly severityWeights: Readonly<Record<Severity, number>>;
  readonly confidenceFactors: Readonly<Record<Confidence, number>>;
}

export const DEFAULT_RISK_MODEL_PARAMETERS: RiskModelParameters = Object.freeze({
  version: RISK_MODEL_VERSION,
  severityWeights: SEVERITY_WEIGHTS,
  confidenceFactors: CONFIDENCE_FACTORS,
});

function contributionOf(finding: ContributingFinding, parameters: RiskModelParameters): number {
  return (
    parameters.severityWeights[finding.severity] * parameters.confidenceFactors[finding.confidence]
  );
}

/**
 * The score is the **worst single input**, not the sum or the mean across them.
 *
 * A sum makes a large site score worse than a small bad one for having more pages. A mean makes one
 * terrible page vanish among ninety-nine good ones. The worst input says "this is how bad the worst
 * thing we looked at is", which is a statement that survives being quoted without its denominator —
 * the way this number will actually travel.
 *
 * What it cannot see is breadth: one bad page and ten identical bad pages score the same. That is in
 * the model's limitations rather than in a correction term nobody could justify.
 */
function scoreByInput(
  input: RiskIndexModelInput,
  parameters: RiskModelParameters,
): { score: number; worst: ContributingFinding[] } {
  const groups = new Map<string, ContributingFinding[]>();
  for (const finding of input.contributingFindings) {
    // A journey step is an input; so is each file of a batch. Findings from a single report share
    // one group, which is the whole report.
    const key = finding.stepId ?? inputKeyOf(finding);
    const group = groups.get(key);
    if (group) group.push(finding);
    else groups.set(key, [finding]);
  }

  let best = 0;
  let worst: ContributingFinding[] = [];
  for (const group of groups.values()) {
    const total = group.reduce((sum, finding) => sum + contributionOf(finding, parameters), 0);
    if (total > best) {
      best = total;
      worst = group;
    }
  }
  return { score: capped(best), worst };
}

/**
 * Which input a finding came from, when it does not name a journey step.
 *
 * Batch findings carry an input-index prefix on their id (`0:rule/id#1`), which is the only per-input
 * marker the report shape guarantees. A finding without one is from a single-report scan, where
 * there is one input by definition.
 */
function inputKeyOf(finding: ContributingFinding): string {
  const separator = finding.findingId.indexOf(":");
  return separator > 0 ? finding.findingId.slice(0, separator) : "single";
}

/**
 * The model's confidence in its own score.
 *
 * The confidence of the evidence the score actually rests on — the findings on the worst input — and
 * nothing about coverage, which is reported separately and answers a different question.
 *
 * A score of zero is `low` confidence, always. It is the least informative output this model
 * produces and the one most likely to be quoted: nothing was found by these rules on these inputs,
 * which is not the same as nothing being there.
 */
function confidenceOf(
  worst: readonly ContributingFinding[],
  parameters: RiskModelParameters,
): Confidence {
  if (worst.length === 0) return "low";
  const weight = worst.reduce((sum, finding) => sum + contributionOf(finding, parameters), 0);
  if (weight === 0) return "low";
  const highShare =
    worst
      .filter((finding) => finding.confidence === "high")
      .reduce((sum, finding) => sum + contributionOf(finding, parameters), 0) / weight;
  const lowShare =
    worst
      .filter((finding) => finding.confidence === "low")
      .reduce((sum, finding) => sum + contributionOf(finding, parameters), 0) / weight;
  if (highShare >= 0.5) return "high";
  if (lowShare >= 0.5) return "low";
  return "medium";
}

const MODEL_LIMITATIONS: readonly string[] = Object.freeze([
  "The score is the worst single input. Ten equally bad pages score the same as one — breadth is not represented.",
  "It saturates at 100, which five high-confidence high-severity findings on one page already reach.",
  "It weighs what these rules detect. A risk they cannot detect contributes nothing, whatever its size.",
  "Weights and confidence factors are this model's judgement, versioned as fairux-risk/1, and not a measurement of harm.",
]);

/**
 * The built-in Risk Index model.
 *
 * `requiredCapabilities` is `structure` and `text` — what every built-in rule needs before its
 * absence means anything. Without them the rules are silent for reasons that have nothing to do with
 * the page, and a score built on that silence would be a number about the scanner.
 *
 * There is deliberately no `minimumExecutedRuleRatio`. Most skipped rules on a healthy scan are
 * skipped for page context — a checkout rule on a marketing page — and that is correct behaviour
 * rather than lost coverage. Gating on the ratio would refuse to score ordinary pages while saying
 * nothing about the skips that do matter, which the report's own coverage already names.
 */
export const fairuxRiskIndexModel: RiskIndexModel = createRiskIndexModel(
  DEFAULT_RISK_MODEL_PARAMETERS,
);

/**
 * Build a model from a set of parameters.
 *
 * Exported so the calibration harness can perturb the weights and measure what happens to the *real*
 * formula. A sensitivity analysis run against a second copy of the arithmetic measures the copy, and
 * the two would drift apart exactly when it mattered.
 *
 * A model built with anything other than the shipped parameters is not `fairux-risk/1` and must not
 * claim to be — hence the version travelling with the parameters rather than being fixed here.
 */
export function createRiskIndexModel(parameters: RiskModelParameters): RiskIndexModel {
  return Object.freeze({
    version: parameters.version,
    requiredCapabilities: Object.freeze(["structure", "text"]) as never,
    evaluate: (input: RiskIndexModelInput): RiskIndexModelResult => {
      const { score, worst } = scoreByInput(input, parameters);
      return {
        score,
        confidence: confidenceOf(worst, parameters),
        limitations: MODEL_LIMITATIONS,
      };
    },
  });
}
