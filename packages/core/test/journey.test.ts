import { describe, expect, it } from "vitest";
import type { JourneyRule, JourneyStep, Rule, RuleMeta, UiDocument } from "../src/index.js";
import { JourneyInputError, scanJourney } from "../src/index.js";
import { makeDoc } from "./_helpers.js";

const page = (label: string, opts: { capabilities?: readonly string[] } = {}): UiDocument =>
  makeDoc(
    { tag: "div", children: [{ tag: "button", text: label }] },
    opts.capabilities ? { capabilities: opts.capabilities as never } : {},
  );

function step(id: string, order: number, extra: Partial<JourneyStep> = {}): JourneyStep {
  return { id, order, document: page(id), ...extra };
}

const meta = (over: Partial<RuleMeta> = {}): RuleMeta => ({
  id: "test/journey",
  title: "Test journey rule",
  category: "obstruction",
  defaultSeverity: "medium",
  defaultConfidence: "low",
  defaultEnabled: true,
  tags: [],
  version: "1.0.0",
  maturity: "stable",
  requiredCapabilities: ["journey", "structure"],
  evidenceRequirements: ["sequence"],
  ...over,
});

/** Flags the flow when a later step's button text differs from the first's. */
const offerChangedRule: JourneyRule = {
  meta: meta(),
  evaluate(journey, ctx) {
    const first = journey.steps[0];
    const changed = journey.steps
      .slice(1)
      .find((entry) => entry.doc.root.normalizedText !== first?.doc.root.normalizedText);
    if (!first || !changed) return [];
    return [
      ctx.createFinding({
        stepId: changed.id,
        evidence: [
          { text: first.doc.root.normalizedText, stepId: first.id },
          { text: changed.doc.root.normalizedText },
        ],
        description: "What the flow offered changed between steps.",
        whyItMatters: "A commitment made on one screen is not the one the next screen honours.",
        recommendation: "Keep the offer consistent across the flow.",
      }),
    ];
  },
};

/** A document rule, to prove the step layer is untouched. */
const buttonRule: Rule = {
  meta: meta({ id: "test/buttons", requiredCapabilities: ["structure"] }),
  evaluate(doc, ctx) {
    return doc
      .findAll((node) => node.tag === "button")
      .map((node) =>
        ctx.createFinding({
          evidence: [{ locator: node.locator, text: node.subtreeText }],
          description: "button",
          whyItMatters: "why",
          recommendation: "fix",
        }),
      );
  },
};

const fixedClock = { now: () => new Date("2026-01-01T00:00:00.000Z"), toolVersion: "9.9.9" };

describe("a journey input that cannot be scanned", () => {
  it("refuses an empty journey rather than reporting a clean flow", () => {
    expect(() => scanJourney({ steps: [] }, [])).toThrow(JourneyInputError);
  });

  it("refuses a duplicate step id", () => {
    expect(() => scanJourney({ steps: [step("a", 1), step("a", 2)] }, [])).toThrow(
      /duplicate journey step id/,
    );
  });

  it("refuses a duplicate order, because before and after become undecidable", () => {
    expect(() => scanJourney({ steps: [step("a", 1), step("b", 1)] }, [])).toThrow(
      /duplicate journey step order/,
    );
  });

  it("refuses a step with no id, no integer order, or no document", () => {
    expect(() => scanJourney({ steps: [step("", 1)] }, [])).toThrow(JourneyInputError);
    expect(() => scanJourney({ steps: [step("a", 1.5)] }, [])).toThrow(JourneyInputError);
    expect(() =>
      scanJourney({ steps: [{ id: "a", order: 1 } as unknown as JourneyStep] }, []),
    ).toThrow(JourneyInputError);
  });

  it("fails the journey when a step fails, rather than reporting the rest", () => {
    const exploding: Rule = {
      meta: meta({ id: "test/throws", requiredCapabilities: ["structure"] }),
      evaluate() {
        throw new Error("rule exploded");
      },
    };
    // Half a flow reported as a whole one would say a cancellation path was checked when only its
    // first page was.
    expect(() => scanJourney({ steps: [step("a", 1), step("b", 2)] }, [exploding])).toThrow(
      /rule exploded/,
    );
  });
});

describe("the two output layers", () => {
  const journey = {
    steps: [
      { id: "pricing", order: 1, document: page("Start free trial"), url: "/pricing" },
      { id: "checkout", order: 2, document: page("Subscribe now"), url: "/checkout" },
    ],
  };

  it("keeps each step's own report exactly as scan() produces it", () => {
    const report = scanJourney(journey, [buttonRule], fixedClock);
    expect(report.steps.map((entry) => entry.id)).toEqual(["pricing", "checkout"]);
    expect(report.steps[0]?.report.kind).toBe("single");
    expect(report.steps[0]?.report.summary.total).toBe(1);
    expect(report.steps[0]?.url).toBe("/pricing");
  });

  it("keeps journey findings disjoint from the steps', so neither double counts", () => {
    const report = scanJourney(journey, [buttonRule], {
      ...fixedClock,
      journeyRules: [offerChangedRule],
    });
    expect(report.summary.total).toBe(1);
    expect(report.stepSummary.total).toBe(2);
    expect(report.findings.map((finding) => finding.ruleId)).toEqual(["test/journey"]);
    for (const entry of report.steps) {
      expect(entry.report.findings.every((finding) => finding.ruleId === "test/buttons")).toBe(
        true,
      );
    }
  });

  it("anchors every piece of a journey finding's evidence to a step", () => {
    const report = scanJourney(journey, [], { ...fixedClock, journeyRules: [offerChangedRule] });
    const finding = report.findings[0];
    expect(finding?.evidence.map((item) => item.stepId)).toEqual(["pricing", "checkout"]);
  });

  it("refuses a finding anchored to a step that is not in the journey", () => {
    const misanchored: JourneyRule = {
      meta: meta({ id: "test/misanchored" }),
      evaluate(_journey, ctx) {
        return [
          ctx.createFinding({
            stepId: "nowhere",
            evidence: [{ text: "x" }],
            description: "d",
            whyItMatters: "w",
            recommendation: "r",
          }),
        ];
      },
    };
    expect(() => scanJourney(journey, [], { journeyRules: [misanchored] })).toThrow(
      /unknown journey step/,
    );
  });
});

describe("order is the contract, not array position", () => {
  it("scans in order, whatever order the caller passed", () => {
    const shuffled = {
      steps: [
        { id: "second", order: 2, document: page("second") },
        { id: "first", order: 1, document: page("first") },
      ],
    };
    expect(scanJourney(shuffled, [], fixedClock).steps.map((entry) => entry.id)).toEqual([
      "first",
      "second",
    ]);
  });

  it("changes the result when the flow is reversed", () => {
    const forward = scanJourney(
      {
        steps: [
          { id: "a", order: 1, document: page("Start free trial") },
          { id: "b", order: 2, document: page("Subscribe now") },
        ],
      },
      [],
      { ...fixedClock, journeyRules: [offerChangedRule] },
    );
    const backward = scanJourney(
      {
        steps: [
          { id: "a", order: 2, document: page("Start free trial") },
          { id: "b", order: 1, document: page("Subscribe now") },
        ],
      },
      [],
      { ...fixedClock, journeyRules: [offerChangedRule] },
    );
    expect(forward.findings[0]?.evidence[0]?.stepId).toBe("a");
    expect(backward.findings[0]?.evidence[0]?.stepId).toBe("b");
    expect(backward.findings[0]?.fingerprint).not.toBe(forward.findings[0]?.fingerprint);
  });

  it("is deterministic: the same journey twice produces the same report", () => {
    const build = () =>
      scanJourney(
        {
          steps: [
            { id: "a", order: 1, document: page("Start free trial") },
            { id: "b", order: 2, document: page("Subscribe now") },
          ],
        },
        [buttonRule],
        { ...fixedClock, journeyRules: [offerChangedRule] },
      );
    expect(JSON.stringify(build())).toEqual(JSON.stringify(build()));
  });
});

describe("journey coverage", () => {
  const journey = {
    steps: [
      { id: "a", order: 1, document: page("a") },
      { id: "b", order: 2, document: page("b") },
    ],
  };

  it("reports `journey` as available, which a single-document scan never can", () => {
    const report = scanJourney(journey, [], { ...fixedClock, journeyRules: [offerChangedRule] });
    expect(report.coverage?.capabilities.available).toContain("journey");
    expect(report.coverage?.summary).toEqual({ total: 1, eligible: 1, executed: 1, skipped: 0 });
  });

  it("skips a journey rule the flow cannot supply for, and says what was missing", () => {
    const needsNetwork: JourneyRule = {
      ...offerChangedRule,
      meta: meta({ id: "test/needs-network", requiredCapabilities: ["journey", "network"] }),
    };
    const report = scanJourney(journey, [], { ...fixedClock, journeyRules: [needsNetwork] });
    expect(report.findings).toEqual([]);
    expect(report.coverage?.rules[0]).toEqual({
      ruleId: "test/needs-network",
      executed: false,
      skipReason: "missing-capability",
      missingCapabilities: ["network"],
    });
  });

  it("offers only what every step supplies", () => {
    // One step read computed style and the other did not. A rule comparing the two would be
    // reading half an answer, so the capability is not offered at all.
    const mixed = {
      steps: [
        {
          id: "a",
          order: 1,
          document: page("a", { capabilities: ["structure", "text", "computed-style"] }),
        },
        { id: "b", order: 2, document: page("b", { capabilities: ["structure", "text"] }) },
      ],
    };
    const report = scanJourney(mixed, [], fixedClock);
    expect(report.coverage?.capabilities.available).toEqual(["structure", "text", "journey"]);
    expect(report.coverage?.capabilities.unavailable).toContain("computed-style");
  });
});
