import { describe, expect, it } from "vitest";
import type { Rule, RuleMeta } from "../src/index.js";
import { RulePackError, scan } from "../src/index.js";
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
      maturity: "stable",
      requiredCapabilities: ["structure", "text"],
      evidenceRequirements: ["presence"],
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

function expectRulePackError(fn: () => void, forbiddenMessage?: string): void {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(RulePackError);
    if (forbiddenMessage) expect(String(error)).not.toContain(forbiddenMessage);
    return;
  }
  throw new Error("expected RulePackError");
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
    const exp = buttonRule({
      id: "test/exp",
      maturity: "experimental",
      experimental: true,
      defaultEnabled: false,
    });
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

  it("rejects invalid createFinding input before report serialization", () => {
    const rule: Rule = {
      ...buttonRule({ id: "test/invalid-create-finding" }),
      evaluate(_doc, ctx) {
        return [
          ctx.createFinding({
            severity: "critical" as never,
            evidence: [{ text: "bad" }],
            description: "bad severity",
            whyItMatters: "why",
            recommendation: "fix",
          }),
        ];
      },
    };

    expect(() => scan(checkoutDoc, [rule])).toThrow(RulePackError);
  });

  it("rejects invalid evaluate return values with RulePackError", () => {
    const nullRule: Rule = {
      ...buttonRule({ id: "test/null-return" }),
      evaluate: () => null as never,
    };
    const sparseRule: Rule = {
      ...buttonRule({ id: "test/sparse-return" }),
      evaluate: () => new Array(1) as never,
    };

    expect(() => scan(checkoutDoc, [nullRule])).toThrow(RulePackError);
    expect(() => scan(checkoutDoc, [sparseRule])).toThrow(RulePackError);
  });

  it("rejects malformed custom findings before summary aggregation", () => {
    const rule: Rule = {
      ...buttonRule({ id: "test/malformed-finding" }),
      evaluate(_doc, ctx) {
        const finding = ctx.createFinding({
          evidence: [{ text: "bad" }],
          description: "bad severity",
          whyItMatters: "why",
          recommendation: "fix",
        });
        return [{ ...finding, severity: "critical" as never }];
      },
    };

    expect(() => scan(checkoutDoc, [rule])).toThrow(RulePackError);
  });

  it("snapshots getter-backed custom findings before summary aggregation", () => {
    let reads = 0;
    const rule: Rule = {
      ...buttonRule({ id: "test/getter-backed-finding", defaultSeverity: "high" }),
      evaluate(_doc, ctx) {
        const finding = {
          ...ctx.createFinding({
            evidence: [{ text: "getter-backed severity" }],
            description: "severity changes after validation",
            whyItMatters: "why",
            recommendation: "fix",
          }),
        };
        Object.defineProperty(finding, "severity", {
          enumerable: true,
          configurable: true,
          get() {
            reads += 1;
            return reads === 1 ? "high" : "critical";
          },
        });
        return [finding as never];
      },
    };

    const report = scan(checkoutDoc, [rule]);

    expect(report.findings[0]?.severity).toBe("high");
    expect(report.summary.bySeverity.high).toBe(1);
    expect((report.summary.bySeverity as Record<string, number>).critical).toBeUndefined();
    expect(Object.values(report.summary.bySeverity).every(Number.isFinite)).toBe(true);
    expect(reads).toBe(1);
  });

  it("snapshots custom finding evidence and references", () => {
    const path = [0, 1];
    const source = { file: "checkout.html", startLine: 3 };
    const evidenceItem = {
      locator: { type: "path" as const, value: path },
      text: "original text",
      source,
    };
    const evidence = [evidenceItem];
    const references = ["https://example.test/original"];
    const rule: Rule = {
      ...buttonRule({ id: "test/snapshot-finding" }),
      evaluate(_doc, ctx) {
        return [
          ctx.createFinding({
            evidence,
            description: "snapshot nested data",
            whyItMatters: "why",
            recommendation: "fix",
            references,
          }),
        ];
      },
    };

    const report = scan(checkoutDoc, [rule]);
    path[0] = 99;
    source.file = "changed.html";
    source.startLine = 99;
    evidenceItem.text = "mutated text";
    evidence[0] = {
      locator: { type: "path", value: [8, 8] },
      text: "mutated text",
      source: { file: "changed.html", startLine: 99 },
    };
    references[0] = "https://example.test/changed";

    expect(report.findings[0]?.evidence).toEqual([
      {
        locator: { type: "path", value: [0, 1] },
        text: "original text",
        source: { file: "checkout.html", startLine: 3 },
      },
    ]);
    expect(report.findings[0]?.references).toEqual(["https://example.test/original"]);
  });

  it("rejects custom findings whose category does not match the rule meta category", () => {
    const rule: Rule = {
      ...buttonRule({ id: "test/category-mismatch", category: "obstruction" }),
      evaluate(_doc, ctx) {
        const finding = ctx.createFinding({
          evidence: [{ text: "wrong category" }],
          description: "category mismatch",
          whyItMatters: "why",
          recommendation: "fix",
        });
        return [{ ...finding, category: "privacy" as never }];
      },
    };

    expect(() => scan(checkoutDoc, [rule])).toThrow(RulePackError);
  });

  it("rejects duplicate finding ids across the report", () => {
    const rule: Rule = {
      ...buttonRule({ id: "test/duplicate-finding-id" }),
      evaluate(_doc, ctx) {
        const first = ctx.createFinding({
          evidence: [{ text: "first duplicate" }],
          description: "duplicate id",
          whyItMatters: "why",
          recommendation: "fix",
        });
        const second = ctx.createFinding({
          evidence: [{ text: "second duplicate" }],
          description: "duplicate id",
          whyItMatters: "why",
          recommendation: "fix",
        });
        return [
          { ...first, id: "duplicate" },
          { ...second, id: "duplicate" },
        ];
      },
    };

    expect(() => scan(checkoutDoc, [rule])).toThrow(RulePackError);
  });

  it("reads valid optional custom rule properties once", () => {
    let inputTitleReads = 0;
    let fingerprintTextReads = 0;
    let batchOccurrenceReads = 0;
    let evidenceTextReads = 0;
    let evidenceSnippetReads = 0;
    let sourceFileReads = 0;
    let sourceStartLineReads = 0;
    let sourceStartColumnReads = 0;
    const rule: Rule = {
      ...buttonRule({ id: "test/single-read-valid-optionals" }),
      evaluate(_doc, ctx) {
        const input = {
          evidence: [{ text: "input evidence" }],
          description: "single read",
          whyItMatters: "why",
          recommendation: "fix",
        };
        Object.defineProperty(input, "title", {
          enumerable: true,
          configurable: true,
          get() {
            inputTitleReads += 1;
            return "Single-read title";
          },
        });
        Object.defineProperty(input, "fingerprintText", {
          enumerable: true,
          configurable: true,
          get() {
            fingerprintTextReads += 1;
            return "single-read fingerprint";
          },
        });
        const finding = { ...ctx.createFinding(input) };
        const source = {};
        Object.defineProperty(source, "file", {
          enumerable: true,
          configurable: true,
          get() {
            sourceFileReads += 1;
            return "checkout.html";
          },
        });
        Object.defineProperty(source, "startLine", {
          enumerable: true,
          configurable: true,
          get() {
            sourceStartLineReads += 1;
            return 3;
          },
        });
        Object.defineProperty(source, "startColumn", {
          enumerable: true,
          configurable: true,
          get() {
            sourceStartColumnReads += 1;
            return 7;
          },
        });
        const evidence = { source };
        Object.defineProperty(evidence, "text", {
          enumerable: true,
          configurable: true,
          get() {
            evidenceTextReads += 1;
            return "valid text";
          },
        });
        Object.defineProperty(evidence, "snippet", {
          enumerable: true,
          configurable: true,
          get() {
            evidenceSnippetReads += 1;
            return "<button>Buy</button>";
          },
        });
        Object.defineProperty(finding, "batchOccurrenceId", {
          enumerable: true,
          configurable: true,
          get() {
            batchOccurrenceReads += 1;
            return "batch-1";
          },
        });
        return [{ ...finding, evidence: [evidence] as never }];
      },
    };

    const report = scan(checkoutDoc, [rule]);

    expect(report.findings[0]?.title).toBe("Single-read title");
    expect(report.findings[0]?.batchOccurrenceId).toBe("batch-1");
    expect(report.findings[0]?.evidence[0]).toEqual({
      text: "valid text",
      snippet: "<button>Buy</button>",
      source: { file: "checkout.html", startLine: 3, startColumn: 7 },
    });
    expect(inputTitleReads).toBe(1);
    expect(fingerprintTextReads).toBe(1);
    expect(batchOccurrenceReads).toBe(1);
    expect(evidenceTextReads).toBe(1);
    expect(evidenceSnippetReads).toBe(1);
    expect(sourceFileReads).toBe(1);
    expect(sourceStartLineReads).toBe(1);
    expect(sourceStartColumnReads).toBe(1);
  });

  it("rejects changing optional getters instead of snapshotting malformed values", () => {
    let batchOccurrenceReads = 0;
    let evidenceTextReads = 0;
    let sourceFileReads = 0;
    const batchRule: Rule = {
      ...buttonRule({ id: "test/changing-batch-occurrence" }),
      evaluate(_doc, ctx) {
        const finding = {
          ...ctx.createFinding({
            evidence: [{ text: "batch" }],
            description: "changing batch occurrence",
            whyItMatters: "why",
            recommendation: "fix",
          }),
        };
        Object.defineProperty(finding, "batchOccurrenceId", {
          enumerable: true,
          configurable: true,
          get() {
            batchOccurrenceReads += 1;
            return batchOccurrenceReads === 1 ? 123 : "valid";
          },
        });
        return [finding as never];
      },
    };
    const evidenceRule: Rule = {
      ...buttonRule({ id: "test/changing-evidence-text" }),
      evaluate(_doc, ctx) {
        const evidence = {};
        Object.defineProperty(evidence, "text", {
          enumerable: true,
          configurable: true,
          get() {
            evidenceTextReads += 1;
            return evidenceTextReads === 1 ? 123 : "valid";
          },
        });
        return [
          ctx.createFinding({
            evidence: [evidence as never],
            description: "changing evidence text",
            whyItMatters: "why",
            recommendation: "fix",
          }),
        ];
      },
    };
    const sourceRule: Rule = {
      ...buttonRule({ id: "test/changing-source-file" }),
      evaluate(_doc, ctx) {
        const source = {};
        Object.defineProperty(source, "file", {
          enumerable: true,
          configurable: true,
          get() {
            sourceFileReads += 1;
            return sourceFileReads === 1 ? 123 : "checkout.html";
          },
        });
        return [
          ctx.createFinding({
            evidence: [{ text: "source", source }],
            description: "changing source file",
            whyItMatters: "why",
            recommendation: "fix",
          }),
        ];
      },
    };

    expectRulePackError(() => scan(checkoutDoc, [batchRule]));
    expectRulePackError(() => scan(checkoutDoc, [evidenceRule]), "text.normalize");
    expectRulePackError(() => scan(checkoutDoc, [sourceRule]));
    expect(batchOccurrenceReads).toBe(1);
    expect(evidenceTextReads).toBe(1);
    expect(sourceFileReads).toBe(1);
  });

  it("rejects createFinding optional getter bypasses before fingerprinting", () => {
    let titleReads = 0;
    let fingerprintTextReads = 0;
    const titleRule: Rule = {
      ...buttonRule({ id: "test/changing-create-title" }),
      evaluate(_doc, ctx) {
        const input = {
          evidence: [{ text: "title" }],
          description: "changing title",
          whyItMatters: "why",
          recommendation: "fix",
        };
        Object.defineProperty(input, "title", {
          enumerable: true,
          configurable: true,
          get() {
            titleReads += 1;
            return titleReads === 1 ? 123 : "valid title";
          },
        });
        return [ctx.createFinding(input as never)];
      },
    };
    const fingerprintRule: Rule = {
      ...buttonRule({ id: "test/changing-fingerprint-text" }),
      evaluate(_doc, ctx) {
        const input = {
          evidence: [{ text: "fingerprint" }],
          description: "changing fingerprint text",
          whyItMatters: "why",
          recommendation: "fix",
        };
        Object.defineProperty(input, "fingerprintText", {
          enumerable: true,
          configurable: true,
          get() {
            fingerprintTextReads += 1;
            return fingerprintTextReads === 1 ? 123 : "valid fingerprint";
          },
        });
        return [ctx.createFinding(input as never)];
      },
    };

    expectRulePackError(() => scan(checkoutDoc, [titleRule]));
    expectRulePackError(() => scan(checkoutDoc, [fingerprintRule]), "text.normalize");
    expect(titleReads).toBe(1);
    expect(fingerprintTextReads).toBe(1);
  });

  it("converts throwing rule result getters to RulePackError", () => {
    let reads = 0;
    const rule: Rule = {
      ...buttonRule({ id: "test/throwing-evidence-getter" }),
      evaluate(_doc, ctx) {
        const evidence = {};
        Object.defineProperty(evidence, "text", {
          enumerable: true,
          configurable: true,
          get() {
            reads += 1;
            throw new Error("getter failure");
          },
        });
        return [
          ctx.createFinding({
            evidence: [evidence as never],
            description: "throwing getter",
            whyItMatters: "why",
            recommendation: "fix",
          }),
        ];
      },
    };

    expectRulePackError(() => scan(checkoutDoc, [rule]), "getter failure");
    expect(reads).toBe(1);
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
    const exp = buttonRule({
      id: "test/exp",
      maturity: "experimental",
      experimental: true,
      defaultEnabled: false,
    });
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
