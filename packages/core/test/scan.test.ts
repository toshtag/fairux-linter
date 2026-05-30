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

describe("scan ruleOverrides", () => {
  it("disables a rule when override is `false`", () => {
    const rule = buttonRule();
    const report = scan(checkoutDoc, [rule], { ruleOverrides: { "test/buttons": false } });
    expect(report.summary.total).toBe(0);
  });

  it("disables a rule when override is `{ enabled: false }`", () => {
    const rule = buttonRule();
    const report = scan(checkoutDoc, [rule], {
      ruleOverrides: { "test/buttons": { enabled: false } },
    });
    expect(report.summary.total).toBe(0);
  });

  it("overrides severity without disturbing detection", () => {
    const rule = buttonRule(); // defaultSeverity: medium
    const report = scan(checkoutDoc, [rule], {
      ruleOverrides: { "test/buttons": { severity: "high" } },
    });
    expect(report.summary.total).toBe(1);
    expect(report.findings[0]?.severity).toBe("high");
    expect(report.summary.bySeverity.high).toBe(1);
    expect(report.summary.bySeverity.medium).toBe(0);
  });

  it("force-enables an experimental rule via `{ enabled: true }` (bypasses includeExperimental)", () => {
    const exp = buttonRule({ id: "test/exp", experimental: true, defaultEnabled: false });
    const report = scan(checkoutDoc, [exp], {
      ruleOverrides: { "test/exp": { enabled: true } },
    });
    expect(report.summary.total).toBe(1);
  });

  it("absent overrides preserve default behavior", () => {
    const rule = buttonRule();
    const baseline = scan(checkoutDoc, [rule]).summary.total;
    const withEmptyOverrides = scan(checkoutDoc, [rule], { ruleOverrides: {} }).summary.total;
    expect(withEmptyOverrides).toBe(baseline);
  });

  it("severity override does not change the finding's fingerprint (baseline stability)", () => {
    const rule = buttonRule();
    const before = scan(checkoutDoc, [rule]).findings[0]?.fingerprint;
    const after = scan(checkoutDoc, [rule], {
      ruleOverrides: { "test/buttons": { severity: "high" } },
    }).findings[0]?.fingerprint;
    expect(after).toBe(before);
  });
});
