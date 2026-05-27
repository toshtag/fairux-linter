import { describe, expect, it } from "vitest";
import type { Rule, RuleMeta } from "../src/index.js";
import { scan } from "../src/index.js";
import { makeDoc } from "./_helpers.js";

const checkoutDoc = makeDoc(
  { tag: "div", children: [{ tag: "button", text: "Buy now" }] },
  { pageContexts: [{ context: "checkout", confidence: "high" }] },
);

/** A trivial rule that flags every <button>, with overridable meta. */
function buttonRule(overrides: Partial<RuleMeta> = {}): Rule {
  return {
    meta: {
      id: "test/buttons",
      title: "Test buttons",
      category: "obstruction",
      defaultSeverity: "medium",
      defaultConfidence: "low",
      defaultEnabled: true,
      tags: [],
      version: "1.0.0",
      ...overrides,
    },
    evaluate(doc, ctx) {
      return doc
        .findAll((n) => n.tag === "button")
        .map((n) =>
          ctx.createFinding({
            evidence: [{ locator: n.locator, text: n.subtreeText }],
            description: "button found",
            whyItMatters: "why",
            recommendation: "fix",
          }),
        );
    },
  };
}

describe("scan", () => {
  it("produces a FairUxReport envelope with summary counts", () => {
    const report = scan(checkoutDoc, [buttonRule()], {
      now: () => new Date("2026-01-01T00:00:00Z"),
      toolVersion: "9.9.9",
    });
    expect(report.schemaVersion).toBe("0.1");
    expect(report.toolVersion).toBe("9.9.9");
    expect(report.generatedAt).toBe("2026-01-01T00:00:00.000Z");
    expect(report.input).toEqual({ file: undefined, runtime: "html" });
    expect(report.summary.total).toBe(1);
    expect(report.summary.bySeverity.medium).toBe(1);
    expect(report.findings[0]?.id).toBeTruthy();
    expect(report.findings[0]?.fingerprint).toMatch(/^[0-9a-f]{16}$/);
  });

  it("skips experimental rules unless includeExperimental is set", () => {
    const exp = buttonRule({ id: "test/exp", experimental: true, defaultEnabled: false });
    expect(scan(checkoutDoc, [exp]).summary.total).toBe(0);
    expect(scan(checkoutDoc, [exp], { includeExperimental: true }).summary.total).toBe(1);
  });

  it("gates rules by page context via appliesTo", () => {
    const checkoutOnly = buttonRule({ id: "test/checkout", appliesTo: ["checkout"] });
    const pricingOnly = buttonRule({ id: "test/pricing", appliesTo: ["pricing"] });
    expect(scan(checkoutDoc, [checkoutOnly]).summary.total).toBe(1);
    expect(scan(checkoutDoc, [pricingOnly]).summary.total).toBe(0);
  });

  it("respects appliesToMinConfidence", () => {
    const lowSignalDoc = makeDoc(
      { tag: "div", children: [{ tag: "button", text: "Buy" }] },
      { pageContexts: [{ context: "checkout", confidence: "low" }] },
    );
    const needsHigh = buttonRule({ appliesTo: ["checkout"], appliesToMinConfidence: "high" });
    expect(scan(lowSignalDoc, [needsHigh]).summary.total).toBe(0);
  });

  it("assigns unique ids across findings", () => {
    const twoButtons = makeDoc({
      tag: "div",
      children: [
        { tag: "button", text: "a" },
        { tag: "button", text: "b" },
      ],
    });
    const ids = scan(twoButtons, [buttonRule()]).findings.map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
