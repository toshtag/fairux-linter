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

/**
 * How the per-input totals become one number.
 *
 * A parameter rather than a hard-coded `Math.max`, for the same reason the weights are parameters:
 * a candidate aggregation has to be measurable against the *real* grouping and the real contribution
 * arithmetic. Re-implementing either in a calibration harness would measure the copy, and the two
 * would drift apart exactly when it mattered.
 *
 * Only the combination step is swappable. What counts as an input, what a finding contributes, and
 * where the score saturates are the same in every variant, so a difference between two runs is the
 * aggregation and nothing else.
 *
 * The list has **one entry per input the index was computed over**, including the ones that produced
 * nothing — a scanned page with no findings contributes a zero rather than being absent. Without
 * that an aggregation could not tell a site with one problem from a site that is nothing but the
 * problem, because it would never learn how many pages it had looked at.
 */
export type RiskAggregation = (inputTotals: readonly number[]) => number;

/** The shipped one: the worst single input. */
export const WORST_INPUT: RiskAggregation = (totals) =>
  totals.length === 0 ? 0 : Math.max(...totals);

export interface RiskModelParameters {
  readonly version: string;
  readonly severityWeights: Readonly<Record<Severity, number>>;
  readonly confidenceFactors: Readonly<Record<Confidence, number>>;
  /** Defaults to {@link WORST_INPUT}. `fairux-risk/1` sets nothing else, and never will. */
  readonly aggregate?: RiskAggregation;
  /**
   * What this model's number cannot answer. Defaults to the worst-input set.
   *
   * A parameter rather than a constant, because the first line of that set names the aggregation. A
   * model that swapped the aggregation and kept the text would be describing a formula it does not
   * use, in the one field a reader turns to when they distrust the number.
   */
  readonly limitations?: readonly string[];
}

/**
 * How many inputs the same problem has to appear on before the score doubles.
 *
 * Sixteen, which is the whole argument for the curve: `worst × (1 + log₂(affected) / 4)`. A reader
 * can say what it will do before running it — two affected inputs add a quarter, four add a half,
 * sixteen double it — and one problem on one page is scored exactly as `fairux-risk/1` scores it, so
 * the two models agree wherever breadth is not a question.
 *
 * Logarithmic rather than linear because the interesting difference is between one page and several,
 * not between forty and fifty. A linear term reaches the cap on any real site and stops saying
 * anything.
 */
export const BREADTH_DOUBLING_INPUTS = 16;

/**
 * The worst input, raised by how many inputs carry findings at all.
 *
 * Counts affected inputs and never reads the total, which is what keeps it from punishing coverage:
 * scanning ten more clean pages adds ten zeros and cannot lower the number. The alternative — a
 * share of inputs affected — makes scanning less the way to a better score, which the calibration
 * measures rather than assumes.
 */
export const WORST_WITH_BREADTH: RiskAggregation = (totals) => {
  const worst = WORST_INPUT(totals);
  const affected = totals.filter((total) => total > 0).length;
  if (affected <= 1) return worst;
  return worst * (1 + Math.log2(affected) / Math.log2(BREADTH_DOUBLING_INPUTS));
};

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
  const totals: number[] = [];
  for (const group of groups.values()) {
    const total = group.reduce((sum, finding) => sum + contributionOf(finding, parameters), 0);
    totals.push(total);
    if (total > best) {
      best = total;
      worst = group;
    }
  }
  // A zero for every input that produced nothing. `Math.max` cannot tell the difference, so
  // `fairux-risk/1` is unaffected; an aggregation that reads the count would otherwise be measuring
  // only the pages that went wrong and would have no denominator at all.
  while (totals.length < input.coverage.documents) totals.push(0);

  // Confidence stays keyed to the worst input whatever the aggregation is: it answers "how sure are
  // we about the evidence this rests on", and the worst input is the one a reader will look at.
  return { score: capped((parameters.aggregate ?? WORST_INPUT)(totals)), worst };
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

const WORST_INPUT_LIMITATIONS: readonly string[] = Object.freeze([
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

export const RISK_MODEL_V2_VERSION = "fairux-risk/2";

const BREADTH_LIMITATIONS: readonly string[] = Object.freeze([
  "The score is the worst input, raised by how many inputs carried findings. It cannot tell one page with a problem from ten different problems on one page.",
  "It counts affected inputs, so a page whose problem these rules missed is a page it counts as clean.",
  "It saturates at 100, which five high-confidence high-severity findings on one page already reach without any breadth at all.",
  "It weighs what these rules detect. A risk they cannot detect contributes nothing, whatever its size.",
  "Weights, confidence factors, and the doubling point are this model's judgement, versioned as fairux-risk/2, and not a measurement of harm.",
]);

export const RISK_MODEL_V2_PARAMETERS: RiskModelParameters = Object.freeze({
  version: RISK_MODEL_V2_VERSION,
  severityWeights: SEVERITY_WEIGHTS,
  confidenceFactors: CONFIDENCE_FACTORS,
  aggregate: WORST_WITH_BREADTH,
  limitations: BREADTH_LIMITATIONS,
});

/**
 * `fairux-risk/2` — the same weights, an aggregation that can see breadth.
 *
 * The one thing it changes is how per-input totals become a number, because that is the one thing
 * measurement could settle. Reusing `fairux-risk/1`'s weights is deliberate: the calibration showed
 * the severity ratios are not load-bearing on this corpus, so changing them in the same version
 * would be changing something on no evidence while claiming the evidence for something else.
 *
 * It is **not the default**. Two scores are comparable when their `modelVersion` matches and not
 * otherwise, so switching what a bare `computeRiskIndex` returns changes what every existing number
 * meant — a decision for a maintainer, not a consequence of this model existing.
 */
export const fairuxRiskIndexModelV2: RiskIndexModel =
  createRiskIndexModel(RISK_MODEL_V2_PARAMETERS);

/** Every model this pack ships, newest last. A caller selecting by version reads this. */
export const RISK_INDEX_MODELS: readonly RiskIndexModel[] = Object.freeze([
  fairuxRiskIndexModel,
  fairuxRiskIndexModelV2,
]);

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
        limitations: parameters.limitations ?? WORST_INPUT_LIMITATIONS,
      };
    },
  });
}
