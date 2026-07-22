import { describe, expect, it } from "vitest";
import type { CreateScannerOptions, Rule, RuleMeta, RulePack } from "../src/index.js";
import { createScanner, ScannerPolicyError, scan } from "../src/index.js";
import { makeDoc } from "./_helpers.js";

const doc = makeDoc({
  tag: "div",
  children: [{ tag: "button", text: "Buy now" }],
});

function buttonRule(overrides: Partial<RuleMeta> = {}): Rule {
  return {
    meta: {
      id: "test/button",
      title: "Test button",
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
    evaluate(document, ctx) {
      return document
        .findAll((node) => node.tag === "button")
        .map((node) =>
          ctx.createFinding({
            evidence: [{ locator: node.locator, text: node.subtreeText }],
            description: "button found",
            whyItMatters: "why",
            recommendation: "fix",
          }),
        );
    },
  };
}

function pack(rule: Rule = buttonRule()): RulePack {
  return {
    meta: {
      id: "test/pack",
      version: "1.0.0",
      engineApiVersion: "1",
      title: "Test pack",
      status: "stable",
    },
    rules: [rule],
  };
}

function experimentalPack(
  rule: Rule = buttonRule({ id: "test/experimental-pack-rule" }),
): RulePack {
  return {
    meta: {
      ...pack().meta,
      id: "test/experimental-pack",
      status: "experimental",
    },
    rules: [rule],
  };
}

function scannerOptions(options: unknown): CreateScannerOptions {
  return {
    rulePacks: [pack()],
    ...(options as Record<string, unknown>),
  } as unknown as CreateScannerOptions;
}

function expectPolicyError(options: unknown): void {
  expect(() => createScanner(scannerOptions(options))).toThrow(ScannerPolicyError);
}

function expectValidReport(options: CreateScannerOptions): void {
  const report = createScanner(options).scan(doc);
  for (const finding of report.findings) {
    expect(["info", "low", "medium", "high"]).toContain(finding.severity);
  }
  expect(Object.values(report.summary.bySeverity).every(Number.isFinite)).toBe(true);
}

describe("scanner policy normalization", () => {
  it("preserves disabled boolean overrides when severityOverrides targets the same rule", () => {
    const report = createScanner({
      rulePacks: [pack()],
      ruleOverrides: { "test/button": false },
      severityOverrides: { "test/button": "low" },
    }).scan(doc);

    expect(report.summary.total).toBe(0);
  });

  it("preserves force-enabled boolean overrides when severityOverrides targets the same rule", () => {
    const experimentalRule = buttonRule({
      id: "test/experimental",
      maturity: "experimental",
      experimental: true,
      defaultEnabled: false,
    });
    const report = createScanner({
      rulePacks: [pack(experimentalRule)],
      ruleOverrides: { "test/experimental": true },
      severityOverrides: { "test/experimental": "low" },
    }).scan(doc);

    expect(report.summary.total).toBe(1);
    expect(report.findings[0]?.severity).toBe("low");
  });

  it("preserves disabled object overrides when severityOverrides targets the same rule", () => {
    const report = createScanner({
      rulePacks: [pack()],
      ruleOverrides: { "test/button": { enabled: false } },
      severityOverrides: { "test/button": "low" },
    }).scan(doc);

    expect(report.summary.total).toBe(0);
  });

  it("lets severityOverrides supply final severity without changing fingerprints", () => {
    const before = createScanner({
      rulePacks: [pack()],
      ruleOverrides: { "test/button": { severity: "medium" } },
    }).scan(doc);
    const after = createScanner({
      rulePacks: [pack()],
      ruleOverrides: { "test/button": { severity: "medium" } },
      severityOverrides: { "test/button": "low" },
    }).scan(doc);

    expect(after.findings[0]?.severity).toBe("low");
    expect(after.findings[0]?.fingerprint).toBe(before.findings[0]?.fingerprint);
  });

  it("uses own-property override lookup with prototype-safe storage", () => {
    const inherited = Object.create({
      "test/button": false,
    }) as Record<string, boolean>;
    const report = scan(doc, [buttonRule()], { ruleOverrides: inherited });

    expect(report.summary.total).toBe(1);
  });

  it("rejects invalid JavaScript policy values before scanning", () => {
    const protoSeverityOverrides = Object.create(null) as Record<string, string>;
    Object.defineProperty(protoSeverityOverrides, "__proto__", {
      value: "low",
      enumerable: true,
    });
    const symbolOptions = { rulePacks: [pack()], [Symbol("unknown")]: true };
    const symbolRuleOverrides = { "test/button": false, [Symbol("unknown")]: true };
    const symbolSeverityOverrides = { "test/button": "low", [Symbol("unknown")]: true };
    const symbolRuleOverride = { enabled: true, [Symbol("unknown")]: true };

    expect(() => createScanner(null as never)).toThrow(ScannerPolicyError);
    expect(() => createScanner([] as never)).toThrow(ScannerPolicyError);
    expect(() => createScanner(new Date() as never)).toThrow(ScannerPolicyError);
    expect(() => createScanner(new Map() as never)).toThrow(ScannerPolicyError);
    expect(() => createScanner({ rulePacks: null } as never)).toThrow(ScannerPolicyError);
    expect(() => createScanner({ rulePacks: [pack()], unknown: true } as never)).toThrow(
      ScannerPolicyError,
    );
    expect(() =>
      createScanner({ rulePacks: [pack()], includeExperimantal: true } as never),
    ).toThrow(ScannerPolicyError);
    expect(() => createScanner({ rulePacks: [pack()], toolVersion: null } as never)).toThrow(
      ScannerPolicyError,
    );
    expect(() => createScanner(symbolOptions as never)).toThrow(ScannerPolicyError);
    expectPolicyError({ includeExperimental: "true" });
    for (const locale of [
      "english_us",
      "en--US",
      "en-u",
      "en-x",
      "-x-private",
      "x",
      "de-1901-1901",
      "sl-rozaj-rozaj",
      "sl-rozaj-ROZAJ",
      "en-a-foo-a-bar",
    ]) {
      expectPolicyError({ locale });
    }
    expectPolicyError({ toolVersion: "" });
    expectPolicyError({ now: "today" });
    expectPolicyError({ ruleOverrides: [] });
    expectPolicyError({ ruleOverrides: { "test/button": [] } });
    expectPolicyError({ ruleOverrides: { "test/button": { enabled: "yes" } } });
    expectPolicyError({ ruleOverrides: { "test/button": { severity: "critical" } } });
    expectPolicyError({ ruleOverrides: { "test/button": { unknown: true } } });
    expectPolicyError({ ruleOverrides: symbolRuleOverrides });
    expectPolicyError({ ruleOverrides: { "test/button": symbolRuleOverride } });
    expectPolicyError({ severityOverrides: [] });
    expectPolicyError({ severityOverrides: { "test/button": "critical" } });
    expectPolicyError({ severityOverrides: symbolSeverityOverrides });
    expectPolicyError({ severityOverrides: null });
    expectPolicyError({ ruleOverrides: { constructor: false } });
    expectPolicyError({ severityOverrides: protoSeverityOverrides });
  });

  it("accepts RFC 5646 scanner locale syntax", () => {
    for (const locale of [
      "en",
      "ja-JP",
      "zh-Hant-TW",
      "de-CH-1901",
      "sl-rozaj-biske-1994",
      "en-u-ca-gregory",
      "de-CH-x-phonebk",
      "x-private",
      "i-klingon",
      "en-a-foo-x-a-bar",
    ]) {
      expect(() => createScanner({ rulePacks: [pack()], locale })).not.toThrow();
    }
  });

  it("accepts null-prototype scanner options and ignores prototype pollution", () => {
    const nullPrototypeOptions = Object.assign(Object.create(null), {
      rulePacks: [pack()],
    }) as CreateScannerOptions;

    expect(() => createScanner(nullPrototypeOptions)).not.toThrow();

    const experimentalRule = buttonRule({
      id: "test/inherited-experimental",
      maturity: "experimental",
      defaultEnabled: false,
      experimental: true,
    });
    Object.defineProperty(Object.prototype, "includeExperimental", {
      value: true,
      configurable: true,
    });
    try {
      const report = createScanner({
        rulePacks: [pack(experimentalRule)],
      }).scan(doc);

      expect(report.summary.total).toBe(0);
    } finally {
      delete (Object.prototype as { includeExperimental?: unknown }).includeExperimental;
    }
  });

  it("rejects invalid clock return values as scanner policy errors", () => {
    const scanner = createScanner(
      scannerOptions({ now: () => "2026-01-01" }) as CreateScannerOptions,
    );

    expect(() => scanner.scan(doc)).toThrow(ScannerPolicyError);
  });

  it("rejects unknown rule override ids before scanner construction succeeds", () => {
    expect(() =>
      createScanner({
        rulePacks: [pack()],
        ruleOverrides: { "test/buton": false },
      }),
    ).toThrow(ScannerPolicyError);

    try {
      createScanner({
        rulePacks: [pack()],
        ruleOverrides: { "test/buton": false },
      });
    } catch (error) {
      expect(error).toBeInstanceOf(ScannerPolicyError);
      expect((error as ScannerPolicyError).field).toBe("ruleOverrides.test/buton");
      expect(String((error as Error).message)).toContain("test/button");
    }
  });

  it("rejects unknown severity override ids with the source field", () => {
    try {
      createScanner({
        rulePacks: [pack()],
        severityOverrides: { "test/buton": "low" },
      });
    } catch (error) {
      expect(error).toBeInstanceOf(ScannerPolicyError);
      expect((error as ScannerPolicyError).field).toBe("severityOverrides.test/buton");
      return;
    }
    throw new Error("expected scanner policy error");
  });

  it("accepts known custom pack rule ids in override maps", () => {
    expect(() =>
      createScanner({
        rulePacks: [pack(buttonRule({ id: "test/custom" }))],
        ruleOverrides: { "test/custom": false },
        severityOverrides: { "test/custom": "low" },
      }),
    ).not.toThrow();
  });

  it("keeps rule-level experimental force-enable available by rule id", () => {
    const report = createScanner({
      rulePacks: [
        pack(
          buttonRule({
            id: "test/rule-experimental",
            maturity: "experimental",
            defaultEnabled: false,
            experimental: true,
          }),
        ),
      ],
      ruleOverrides: { "test/rule-experimental": true },
    }).scan(doc);

    expect(report.summary.total).toBe(1);
  });

  it("rejects overrides for rules from excluded experimental packs", () => {
    expect(() =>
      createScanner({
        rulePacks: [experimentalPack()],
        ruleOverrides: { "test/experimental-pack-rule": true },
      }),
    ).toThrow(ScannerPolicyError);
  });

  it("keeps report severity and summary values inside the public schema", () => {
    expectValidReport({
      rulePacks: [pack()],
      ruleOverrides: { "test/button": { severity: "high" } },
      severityOverrides: { "test/button": "low" },
    });
  });
});
