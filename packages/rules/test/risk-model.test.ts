import type { ContributingFinding, RiskIndexModelInput } from "@fairux/core";
import { describe, expect, it } from "vitest";
import {
  BREADTH_DOUBLING_INPUTS,
  CONFIDENCE_FACTORS,
  createRiskIndexModel,
  DEFAULT_RISK_MODEL_PARAMETERS,
  fairuxRiskIndexModel,
  fairuxRiskIndexModelV2,
  MAX_SCORE,
  RISK_INDEX_MODELS,
  SEVERITY_WEIGHTS,
  WORST_INPUT,
} from "../src/index.js";

function finding(over: Partial<ContributingFinding> = {}): ContributingFinding {
  return {
    findingId: over.findingId ?? "rule/a#0",
    ruleId: "rule/a",
    fingerprint: over.fingerprint ?? "0000000000000000",
    severity: over.severity ?? "medium",
    confidence: over.confidence ?? "high",
    ...(over.stepId ? { stepId: over.stepId } : {}),
  };
}

function evaluate(findings: readonly ContributingFinding[]) {
  const input = {
    report: { kind: "single" } as never,
    contributingFindings: findings,
    coverage: {
      documents: 1,
      requiredCapabilities: [],
      missingCapabilities: [],
      rules: { total: 1, eligible: 1, executed: 1, skipped: 0 },
    },
  } as unknown as RiskIndexModelInput;
  return fairuxRiskIndexModel.evaluate(input);
}

describe("the constants are the claim", () => {
  it("doubles per severity step, so many small findings cannot outweigh a serious one", () => {
    expect(SEVERITY_WEIGHTS.high).toBe(SEVERITY_WEIGHTS.medium * 2);
    expect(SEVERITY_WEIGHTS.medium).toBe(SEVERITY_WEIGHTS.low * 2);
    expect(SEVERITY_WEIGHTS.low).toBeGreaterThan(SEVERITY_WEIGHTS.info);
  });

  it("damps a low-confidence finding without dropping it", () => {
    // Dropping it would hide real risk; counting it fully would let a heuristic match weigh as much
    // as a checked one. The calibration shows the separation depends on this being non-zero.
    expect(CONFIDENCE_FACTORS.low).toBeGreaterThan(0);
    expect(CONFIDENCE_FACTORS.low).toBeLessThan(CONFIDENCE_FACTORS.medium);
    expect(CONFIDENCE_FACTORS.high).toBe(1);
  });

  it("names its version, which is what makes two numbers comparable", () => {
    expect(fairuxRiskIndexModel.version).toBe("fairux-risk/1");
    expect(DEFAULT_RISK_MODEL_PARAMETERS.version).toBe("fairux-risk/1");
  });
});

describe("the score", () => {
  it("adds each finding's severity weight, damped by its confidence", () => {
    expect(evaluate([finding({ severity: "high", confidence: "high" })]).score).toBe(20);
    expect(evaluate([finding({ severity: "medium", confidence: "medium" })]).score).toBe(6);
    expect(evaluate([finding({ severity: "low", confidence: "low" })]).score).toBe(2);
  });

  it("is zero with nothing found, and that is the least informative output there is", () => {
    const result = evaluate([]);
    expect(result.score).toBe(0);
    expect(result.confidence).toBe("low");
  });

  it("saturates rather than growing without limit", () => {
    const many = Array.from({ length: 50 }, (_, index) =>
      finding({ findingId: `rule/a#${index}`, severity: "high", confidence: "high" }),
    );
    expect(evaluate(many).score).toBe(MAX_SCORE);
  });

  it("is the worst single input, not the sum across them", () => {
    // Two steps with one medium finding each must not add up to a worse flow than one step with two.
    const spread = evaluate([
      finding({ findingId: "a#0", stepId: "one" }),
      finding({ findingId: "b#0", stepId: "two" }),
    ]);
    const concentrated = evaluate([
      finding({ findingId: "a#0", stepId: "one" }),
      finding({ findingId: "b#0", stepId: "one" }),
    ]);
    expect(spread.score).toBe(10);
    expect(concentrated.score).toBe(20);
  });

  it("groups a batch by its input index, which is the only per-input marker findings carry", () => {
    const batch = evaluate([
      finding({ findingId: "0:rule/a#0" }),
      finding({ findingId: "1:rule/a#0" }),
    ]);
    expect(batch.score).toBe(10);
  });

  it("does not depend on the order findings arrive in", () => {
    const findings = [
      finding({ findingId: "a#0", severity: "high" }),
      finding({ findingId: "b#0", severity: "low", confidence: "low" }),
    ];
    expect(evaluate([...findings].reverse()).score).toBe(evaluate(findings).score);
  });
});

describe("the model's confidence is about its evidence, not its coverage", () => {
  it("is high when the score rests mostly on high-confidence findings", () => {
    expect(evaluate([finding({ severity: "high", confidence: "high" })]).confidence).toBe("high");
  });

  it("is low when it rests mostly on low-confidence ones", () => {
    expect(evaluate([finding({ severity: "high", confidence: "low" })]).confidence).toBe("low");
  });

  it("is medium in between", () => {
    expect(evaluate([finding({ severity: "high", confidence: "medium" })]).confidence).toBe(
      "medium",
    );
  });
});

describe("what the model says it cannot see", () => {
  it("states the aggregation's blind spot, the saturation, and its own authorship", () => {
    const limitations = evaluate([finding()]).limitations?.join(" ") ?? "";
    expect(limitations).toContain("worst single input");
    expect(limitations).toContain("saturates at 100");
    expect(limitations).toContain("not a measurement of harm");
  });
});

describe("a model built from other parameters", () => {
  it("is not fairux-risk/1, and must not claim to be", () => {
    const other = createRiskIndexModel({
      ...DEFAULT_RISK_MODEL_PARAMETERS,
      version: "experiment/1",
      severityWeights: { high: 1, medium: 1, low: 1, info: 1 },
    });
    expect(other.version).toBe("experiment/1");
    expect(other.version).not.toBe(fairuxRiskIndexModel.version);
  });
});

function evaluateWith(
  findings: readonly ContributingFinding[],
  documents: number,
  aggregate?: (totals: readonly number[]) => number,
) {
  const input = {
    report: { kind: "batch" } as never,
    contributingFindings: findings,
    coverage: {
      documents,
      requiredCapabilities: [],
      missingCapabilities: [],
      rules: { total: 1, eligible: 1, executed: 1, skipped: 0 },
    },
  } as unknown as RiskIndexModelInput;
  return createRiskIndexModel({
    ...DEFAULT_RISK_MODEL_PARAMETERS,
    version: "experiment/aggregation",
    ...(aggregate ? { aggregate } : {}),
  }).evaluate(input);
}

/**
 * The seam a candidate aggregation is measured through, rather than a second copy of the arithmetic.
 *
 * `fairux-risk/1` sets nothing here and never will: a different aggregation is a different model
 * version. What this pins is that the seam exists, that it defaults to the shipped behaviour, and
 * that a candidate reading it is handed every input rather than only the ones that went wrong.
 */
describe("the aggregation seam", () => {
  it("defaults to the worst input, so the shipped model is unchanged by its existence", () => {
    const findings = [
      finding({ findingId: "0:rule/a#0", severity: "high" }),
      finding({ findingId: "1:rule/a#0", severity: "low" }),
      finding({ findingId: "1:rule/a#1", severity: "low" }),
    ];
    expect(evaluateWith(findings, 2).score).toBe(20);
    expect(WORST_INPUT([20, 10])).toBe(20);
    expect(WORST_INPUT([])).toBe(0);
  });

  it("hands a zero to the aggregation for every input that produced nothing", () => {
    // Without this an aggregation has no denominator: it would only ever see the pages that went
    // wrong, and could not tell a site with one problem from a site that is nothing but the problem.
    const seen: number[][] = [];
    evaluateWith([finding({ findingId: "0:rule/a#0", severity: "medium" })], 4, (totals) => {
      seen.push([...totals]);
      return 0;
    });
    expect(seen[0]).toEqual([10, 0, 0, 0]);
  });

  it("never shortens the list below the inputs that carry findings", () => {
    const seen: number[][] = [];
    evaluateWith(
      [
        finding({ findingId: "0:rule/a#0", severity: "medium" }),
        finding({ findingId: "1:rule/a#0", severity: "medium" }),
      ],
      // A coverage count lower than the number of groups should not lose one of them.
      1,
      (totals) => {
        seen.push([...totals]);
        return 0;
      },
    );
    expect(seen[0]).toHaveLength(2);
  });

  it("keeps confidence keyed to the worst input, whatever the aggregation returns", () => {
    const result = evaluateWith(
      [
        finding({ findingId: "0:rule/a#0", severity: "high", confidence: "high" }),
        finding({ findingId: "1:rule/a#0", severity: "low", confidence: "low" }),
      ],
      2,
      () => 3,
    );
    expect(result.score).toBe(3);
    expect(result.confidence).toBe("high");
  });

  it("still saturates at the cap, so a candidate cannot report more than 100", () => {
    expect(evaluateWith([finding()], 1, () => 5000).score).toBe(MAX_SCORE);
  });
});

/**
 * `fairux-risk/2` — the same weights, an aggregation that can see breadth.
 *
 * The two claims it has to carry: it agrees with `fairux-risk/1` wherever breadth is not a question,
 * and it cannot be improved by scanning less.
 */
describe("fairux-risk/2", () => {
  const v2 = (findings: readonly ContributingFinding[], documents: number) => {
    const input = {
      report: { kind: "batch" } as never,
      contributingFindings: findings,
      coverage: {
        documents,
        requiredCapabilities: [],
        missingCapabilities: [],
        rules: { total: 1, eligible: 1, executed: 1, skipped: 0 },
      },
    } as unknown as RiskIndexModelInput;
    return fairuxRiskIndexModelV2.evaluate(input);
  };
  const onEachOf = (count: number) =>
    Array.from({ length: count }, (_, index) =>
      finding({ findingId: `${index}:rule/a#0`, severity: "high", confidence: "high" }),
    );

  it("names its own version, because two scores are comparable only when those match", () => {
    expect(fairuxRiskIndexModelV2.version).toBe("fairux-risk/2");
    expect(fairuxRiskIndexModelV2.version).not.toBe(fairuxRiskIndexModel.version);
  });

  it("scores a single input exactly as fairux-risk/1 does", () => {
    // On one input there is nothing to aggregate, so the breadth term must contribute exactly
    // nothing. A difference here would mean it leaked into the case it is not about.
    const findings = onEachOf(1);
    const input = {
      report: { kind: "single" } as never,
      contributingFindings: findings,
      coverage: {
        documents: 1,
        requiredCapabilities: [],
        missingCapabilities: [],
        rules: { total: 1, eligible: 1, executed: 1, skipped: 0 },
      },
    } as unknown as RiskIndexModelInput;
    expect(fairuxRiskIndexModelV2.evaluate(input).score).toBe(
      fairuxRiskIndexModel.evaluate(input).score,
    );
  });

  it("rises with how many inputs carry the problem", () => {
    expect(v2(onEachOf(1), 1).score).toBe(20);
    expect(v2(onEachOf(2), 2).score).toBeGreaterThan(v2(onEachOf(1), 1).score);
    expect(v2(onEachOf(5), 5).score).toBeGreaterThan(v2(onEachOf(2), 2).score);
  });

  it("doubles at the documented number of inputs, and not at a number nobody wrote down", () => {
    expect(v2(onEachOf(BREADTH_DOUBLING_INPUTS), BREADTH_DOUBLING_INPUTS).score).toBe(
      v2(onEachOf(1), 1).score * 2,
    );
  });

  it("cannot be improved by scanning fewer clean pages", () => {
    // The failure the worst-input rule was chosen to avoid, from the other side: if adding a clean
    // page lowered the number, scanning less would be the way to a better one.
    const alone = v2(onEachOf(1), 1).score;
    expect(v2(onEachOf(1), 10).score).toBe(alone);
    expect(v2(onEachOf(1), 100).score).toBe(alone);
  });

  it("still saturates, so breadth cannot report more than the scale has", () => {
    expect(v2(onEachOf(64), 64).score).toBeLessThanOrEqual(MAX_SCORE);
  });

  it("does not describe an aggregation it no longer uses", () => {
    const limitations = v2(onEachOf(2), 2).limitations?.join(" ") ?? "";
    expect(limitations).not.toContain("worst single input");
    expect(limitations).toContain("raised by how many inputs carried findings");
    expect(limitations).toContain("fairux-risk/2");
    // The one this aggregation newly cannot see: breadth of problems on one page.
    expect(limitations).toContain("ten different problems on one page");
  });

  it("keeps fairux-risk/1's own limitations unchanged", () => {
    const v1 = evaluate([finding()]).limitations?.join(" ") ?? "";
    expect(v1).toContain("worst single input");
    expect(v1).toContain("fairux-risk/1");
  });

  it("is listed after fairux-risk/1, so a caller meets the default first", () => {
    expect(RISK_INDEX_MODELS.map((model) => model.version)).toEqual([
      "fairux-risk/1",
      "fairux-risk/2",
    ]);
  });
});
