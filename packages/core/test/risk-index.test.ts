import { describe, expect, it } from "vitest";
import type { FairUxReport, RiskIndexInput, RiskIndexModel } from "../src/index.js";
import { computeRiskIndex, RiskIndexError, scan, scanJourney } from "../src/index.js";
import { makeDoc } from "./_helpers.js";

const clock = { now: () => new Date("2026-01-01T00:00:00.000Z"), toolVersion: "9.9.9" };

const buttonRule = {
  meta: {
    id: "test/buttons",
    title: "Test buttons",
    category: "obstruction" as const,
    defaultSeverity: "medium" as const,
    defaultConfidence: "low" as const,
    defaultEnabled: true,
    tags: [],
    version: "1.0.0",
    maturity: "stable" as const,
    requiredCapabilities: ["structure"] as [string, ...string[]],
    evidenceRequirements: ["presence"] as [string, ...string[]],
  },
  evaluate: (doc: never, ctx: never) =>
    (doc as unknown as { findAll: (p: (n: { tag: string }) => boolean) => unknown[] })
      .findAll((node) => node.tag === "button")
      .map((node) =>
        (ctx as unknown as { createFinding: (i: unknown) => unknown }).createFinding({
          evidence: [{ locator: (node as { locator: unknown }).locator, text: "Buy" }],
          description: "button",
          whyItMatters: "why",
          recommendation: "fix",
        }),
      ),
} as never;

const page = () => makeDoc({ tag: "div", children: [{ tag: "button", text: "Buy now" }] }) as never;

const singleReport = (): FairUxReport => scan(page(), [buttonRule], clock);

/** A model that answers, for exercising the paths a real one will take. Not a formula. */
const countingModel: RiskIndexModel = {
  version: "test-model/1",
  evaluate: ({ contributingFindings }) => ({
    score: contributingFindings.length,
    confidence: "low",
  }),
};

describe("without a model", () => {
  it("is unsupported, with a reason, and never a zero", () => {
    const index = computeRiskIndex(singleReport(), clock);
    expect(index.kind).toBe("risk-index");
    expect(index.status).toBe("unsupported");
    expect(index.score).toBeNull();
    expect(index.confidence).toBeNull();
    expect(index.reason).toEqual({
      code: "no-model",
      message: "no Risk Index model is implemented in this build",
    });
    expect(index.versions.modelVersion).toBeNull();
  });

  it("still reports coverage and the findings a score would rest on", () => {
    const index = computeRiskIndex(singleReport(), clock);
    expect(index.coverage.documents).toBe(1);
    expect(index.coverage.rules.executed).toBeGreaterThan(0);
    expect(index.contributingFindings).toHaveLength(1);
    expect(index.contributingFindings[0]?.ruleId).toBe("test/buttons");
  });

  it("carries limitations that say what a number would not mean", () => {
    const index = computeRiskIndex(singleReport(), clock);
    expect(index.limitations.length).toBeGreaterThan(0);
    expect(index.limitations.join(" ")).toContain("not a safety, legal, or compliance verdict");
    expect(index.limitations.join(" ")).toContain("Zero findings is not zero risk");
  });
});

describe("only one status carries a number", () => {
  it("scores when a model applies and coverage is enough", () => {
    const index = computeRiskIndex(singleReport(), { ...clock, model: countingModel });
    expect(index.status).toBe("sufficient");
    expect(index.score).toBe(1);
    expect(index.confidence).toBe("low");
    expect(index.reason).toBeUndefined();
    expect(index.versions.modelVersion).toBe("test-model/1");
  });

  it("refuses to score when a required capability was missing anywhere", () => {
    const needsNetwork: RiskIndexModel = {
      ...countingModel,
      requiredCapabilities: ["network"],
    };
    const index = computeRiskIndex(singleReport(), { ...clock, model: needsNetwork });
    expect(index.status).toBe("insufficient-coverage");
    expect(index.score).toBeNull();
    expect(index.confidence).toBeNull();
    expect(index.reason?.code).toBe("missing-capability");
    expect(index.coverage.missingCapabilities).toEqual(["network"]);
  });

  it("refuses to score when too few eligible rules ran", () => {
    const demanding: RiskIndexModel = { ...countingModel, minimumExecutedRuleRatio: 1 };
    const blocked = scan(page(), [
      buttonRule,
      {
        ...(buttonRule as unknown as { meta: Record<string, unknown> }),
        meta: {
          ...(buttonRule as unknown as { meta: Record<string, unknown> }).meta,
          id: "test/blocked",
          requiredCapabilities: ["network"],
        },
      } as never,
    ]);
    const index = computeRiskIndex(blocked, { ...clock, model: demanding });
    expect(index.status).toBe("insufficient-coverage");
    expect(index.score).toBeNull();
    expect(index.reason?.code).toBe("insufficient-rule-coverage");
  });

  it("is unsupported when the model does not handle this input", () => {
    const documentsOnly: RiskIndexModel = {
      ...countingModel,
      appliesTo: (report: RiskIndexInput) => report.kind === "single",
    };
    const journey = scanJourney(
      { steps: [{ id: "a", order: 1, document: page() }] },
      [buttonRule],
      clock,
    );
    const index = computeRiskIndex(journey, { ...clock, model: documentsOnly });
    expect(index.status).toBe("unsupported");
    expect(index.score).toBeNull();
    expect(index.reason?.code).toBe("model-not-applicable");
    // Unscored and still named. `versions` is filled from the supplied model before this function
    // asks whether that model applies, so `modelVersion` says which model declined rather than
    // tracking whether a number came out — the contract `report-schema.md` and both packages'
    // JSDoc state, asserted here because `documentsOnly` above is typechecked and this file is in
    // `packages/core/tsconfig.json`'s `include`.
    expect(index.versions.modelVersion).toBe(documentsOnly.version);
  });
});

describe("versions cannot drift", () => {
  it("refuses a model version this build does not have", () => {
    expect(() =>
      computeRiskIndex(singleReport(), { ...clock, modelVersion: "fairux-risk/2" }),
    ).toThrow(RiskIndexError);
    expect(() =>
      computeRiskIndex(singleReport(), {
        ...clock,
        model: countingModel,
        modelVersion: "fairux-risk/2",
      }),
    ).toThrow(/unknown risk index model version/);
  });

  it("accepts the version the model actually has", () => {
    const index = computeRiskIndex(singleReport(), {
      ...clock,
      model: countingModel,
      modelVersion: "test-model/1",
    });
    expect(index.status).toBe("sufficient");
  });

  it("records the schema, model, rule pack, and tool versions together", () => {
    const index = computeRiskIndex(singleReport(), { ...clock, model: countingModel });
    expect(index.versions.schemaVersion).toBe("0.1");
    expect(index.versions.modelVersion).toBe("test-model/1");
    expect(index.versions.toolVersion).toBe("9.9.9");
    expect(index.versions.rulePacks).toEqual([]);
  });

  it("refuses a model that answers with something that is not a number", () => {
    const broken: RiskIndexModel = {
      version: "broken/1",
      evaluate: () => ({ score: Number.NaN, confidence: "low" }),
    };
    expect(() => computeRiskIndex(singleReport(), { ...clock, model: broken })).toThrow(
      /non-numeric score/,
    );
  });
});

describe("the report is deterministic", () => {
  it("produces the same report for the same input, twice", () => {
    const report = singleReport();
    expect(JSON.stringify(computeRiskIndex(report, clock))).toEqual(
      JSON.stringify(computeRiskIndex(report, clock)),
    );
  });

  it("does not change when the findings arrive in a different order", () => {
    // Two scans that differ only in the order rules ran must produce the same index, or the number
    // is noise rather than a measurement.
    const report = scan(
      makeDoc({
        tag: "div",
        children: [
          { tag: "button", text: "one" },
          { tag: "button", text: "two" },
        ],
      }) as never,
      [buttonRule],
      clock,
    );
    const reversed: FairUxReport = { ...report, findings: [...report.findings].reverse() };
    expect(computeRiskIndex(reversed, clock).contributingFindings).toEqual(
      computeRiskIndex(report, clock).contributingFindings,
    );
  });
});

describe("coverage is not confidence", () => {
  it("keeps them as separate fields, and leaves confidence null without a score", () => {
    const index = computeRiskIndex(singleReport(), clock);
    expect(index.confidence).toBeNull();
    expect(index.coverage.rules.eligible).toBeGreaterThan(0);
    // A well-covered scan is not a confident one: the model says how sure it is, coverage says how
    // much was looked at, and neither is derived from the other.
    expect(Object.keys(index.coverage)).not.toContain("confidence");
  });

  it("counts a journey's steps and rolls up their rule coverage", () => {
    const journey = scanJourney(
      {
        steps: [
          { id: "a", order: 1, document: page() },
          { id: "b", order: 2, document: page() },
        ],
      },
      [buttonRule],
      clock,
    );
    const index = computeRiskIndex(journey, clock);
    expect(index.coverage.documents).toBe(2);
    expect(index.coverage.journeySteps).toBe(2);
    expect(index.contributingFindings.every((finding) => finding.stepId !== undefined)).toBe(true);
  });
});
