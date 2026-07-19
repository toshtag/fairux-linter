import { describe, expect, it } from "vitest";
import type { KeywordDictionary, PatternGroup, Rule, RuleMeta, RulePack } from "../src/index.js";
import { composeRulePacks, createScanner, RulePackError, scan } from "../src/index.js";
import { makeDoc } from "./_helpers.js";

const doc = makeDoc({
  tag: "div",
  children: [{ tag: "button", text: "Buy now" }],
});
const PROTOTYPE_SENSITIVE_GROUPS = [
  "constructor",
  "toString",
  "valueOf",
  "hasOwnProperty",
  "__proto__",
] as const;

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

function pack(overrides: Partial<RulePack> = {}): RulePack {
  return {
    meta: {
      id: "test/pack",
      version: "1.0.0",
      engineApiVersion: "1",
      title: "Test pack",
      status: "stable",
    },
    rules: [buttonRule()],
    ...overrides,
  };
}

function prototypeSensitiveDictionary(): KeywordDictionary {
  const group = Object.create(null) as Record<string, readonly RegExp[]>;
  Object.defineProperty(group, "constructor", {
    value: [/alpha/],
    enumerable: true,
    configurable: true,
  });
  Object.defineProperty(group, "toString", {
    value: [/beta/],
    enumerable: true,
    configurable: true,
  });
  Object.defineProperty(group, "valueOf", {
    value: [/delta/],
    enumerable: true,
    configurable: true,
  });
  Object.defineProperty(group, "hasOwnProperty", {
    value: [/epsilon/],
    enumerable: true,
    configurable: true,
  });
  Object.defineProperty(group, "__proto__", {
    value: [/gamma/],
    enumerable: true,
    configurable: true,
  });
  return { en: group };
}

describe("composeRulePacks", () => {
  it("keeps pack and rule ordering deterministic", () => {
    const first = pack({
      meta: { ...pack().meta, id: "test/first" },
      rules: [buttonRule({ id: "test/a" })],
    });
    const second = pack({
      meta: { ...pack().meta, id: "test/second" },
      rules: [buttonRule({ id: "test/b" })],
    });

    const composed = composeRulePacks([first, second]);

    expect(composed.rulePacks.map((meta) => meta.id)).toEqual(["test/first", "test/second"]);
    expect(composed.rules.map((rule) => rule.meta.id)).toEqual(["test/a", "test/b"]);
  });

  it("rejects duplicate pack ids", () => {
    expect(() => composeRulePacks([pack(), pack()])).toThrow(RulePackError);
  });

  it("rejects duplicate rule ids", () => {
    const first = pack({ meta: { ...pack().meta, id: "test/first" } });
    const second = pack({ meta: { ...pack().meta, id: "test/second" } });
    expect(() => composeRulePacks([first, second])).toThrow(/Duplicate rule id/);
  });

  it("rejects unsupported engine API versions", () => {
    expect(() =>
      composeRulePacks([
        pack({
          meta: {
            ...pack().meta,
            // Simulate a future pack at runtime without widening the public type.
            engineApiVersion: "2" as "1",
          },
        }),
      ]),
    ).toThrow(/unsupported engine API 2/);
  });

  it("rejects stateful dictionary patterns", () => {
    const dictionary: KeywordDictionary = { en: { bad: [/bad/g] } };
    expect(() => composeRulePacks([pack({ dictionary })])).toThrow(/stateful RegExp/);
  });

  it("rejects invalid semantic versions", () => {
    expect(() => composeRulePacks([pack({ meta: { ...pack().meta, version: "banana" } })])).toThrow(
      RulePackError,
    );
    expect(() => composeRulePacks([pack({ rules: [buttonRule({ version: "v1.0.0" })] })])).toThrow(
      RulePackError,
    );
  });

  it("wraps structurally invalid packs in RulePackError", () => {
    const inheritedMeta = Object.create(pack().meta) as RulePack["meta"];
    class RulePackMetaFixture {
      id = "test/class-meta";
      version = "1.0.0";
      engineApiVersion = "1" as const;
      title = "Class meta";
      status = "stable" as const;
    }
    const invalidPacks = [
      null,
      { meta: null, rules: [] },
      { meta: pack().meta, rules: null },
      { meta: pack().meta, rules: [null] },
      { meta: pack().meta, rules: [{ meta: null, evaluate: () => [] }] },
      { meta: pack().meta, rules: [{ meta: buttonRule().meta, evaluate: "nope" }] },
      { ...pack(), dictionry: { en: { cta: [/buy/] } } },
      { meta: { ...pack().meta, experimentl: true }, rules: [buttonRule()] },
      { meta: { ...pack().meta, [Symbol("status")]: "stable" }, rules: [buttonRule()] },
      { meta: inheritedMeta, rules: [buttonRule()] },
      { meta: new RulePackMetaFixture(), rules: [buttonRule()] },
      { meta: pack().meta, rules: [{ ...buttonRule(), severity: "high" }] },
      { meta: pack().meta, rules: [buttonRule({ appliesToo: ["checkout"] } as never)] },
      { meta: pack().meta, rules: [buttonRule()], dictionary: null },
      { meta: pack().meta, rules: [buttonRule()], dictionary: false },
      { meta: pack().meta, rules: [buttonRule()], dictionary: 0 },
      { meta: pack().meta, rules: [buttonRule()], dictionary: "" },
      { meta: pack().meta, rules: [buttonRule()], dictionary: [] },
      { meta: pack().meta, rules: [buttonRule()], dictionary: new Date() },
      { meta: pack().meta, rules: [buttonRule()], dictionary: { en: [] } },
      { meta: pack().meta, rules: [buttonRule()], dictionary: { en: { cta: ["buy"] } } },
    ];

    for (const invalidPack of invalidPacks) {
      expect(() => composeRulePacks([invalidPack as RulePack])).toThrow(RulePackError);
    }
  });

  it("merges dictionaries without mutating source packs", () => {
    const firstDictionary: KeywordDictionary = { en: { cta: [/\bbuy\b/] } };
    const secondDictionary: KeywordDictionary = { en: { cta: [/\bbuy\b/, /\border\b/] } };
    const first = pack({
      meta: { ...pack().meta, id: "test/first" },
      dictionary: firstDictionary,
      rules: [buttonRule({ id: "test/a" })],
    });
    const second = pack({
      meta: { ...pack().meta, id: "test/second" },
      dictionary: secondDictionary,
      rules: [buttonRule({ id: "test/b" })],
    });

    const composed = composeRulePacks([first, second]);

    expect(composed.dictionary.en?.cta).toHaveLength(2);
    expect(firstDictionary.en?.cta).toHaveLength(1);
    expect(secondDictionary.en?.cta).toHaveLength(2);
  });

  it("preserves prototype-sensitive dictionary group names", () => {
    const dictionary = prototypeSensitiveDictionary();
    const rule: Rule = {
      ...buttonRule({ id: "test/dictionary" }),
      evaluate(document, ctx) {
        const merged = ctx.getDictionary();
        for (const name of PROTOTYPE_SENSITIVE_GROUPS) {
          expect(merged[name]).toHaveLength(1);
        }
        expect(
          ctx.text.hasAny(document.root.subtreeText, merged[PROTOTYPE_SENSITIVE_GROUPS[0]] ?? []),
        ).toBe(true);
        expect(
          ctx.text.hasAny(document.root.subtreeText, merged[PROTOTYPE_SENSITIVE_GROUPS[4]] ?? []),
        ).toBe(true);
        return [];
      },
    };
    const scanner = createScanner({
      rulePacks: [pack({ dictionary, rules: [rule] })],
    });

    expect(() =>
      scanner.scan(
        makeDoc({
          tag: "main",
          text: "alpha beta gamma delta epsilon",
        }),
      ),
    ).not.toThrow();
  });

  it("deduplicates prototype-sensitive dictionary groups during composition", () => {
    const dictionary: KeywordDictionary = {
      en: Object.assign(Object.create(null), {
        constructor: [/alpha/, /alpha/],
      }) as PatternGroup,
    };
    const composed = composeRulePacks([pack({ dictionary })]);

    expect(composed.dictionary.en?.constructor).toHaveLength(1);
    expect(Object.hasOwn(composed.dictionary.en ?? {}, "constructor")).toBe(true);
  });

  it("treats only undefined as an absent dictionary", () => {
    expect(() => composeRulePacks([pack({ dictionary: undefined })])).not.toThrow();

    for (const dictionary of [null, false, 0, "", [], new Date()]) {
      expect(() => composeRulePacks([pack({ dictionary: dictionary as never })])).toThrow(
        RulePackError,
      );
    }
  });

  it("omits experimental packs unless requested", () => {
    const experimental = pack({
      meta: { ...pack().meta, status: "experimental" },
    });
    expect(composeRulePacks([experimental]).rules).toHaveLength(0);
    expect(composeRulePacks([experimental], { includeExperimental: false }).rules).toHaveLength(0);
    expect(composeRulePacks([experimental], { includeExperimental: true }).rules).toHaveLength(1);
  });

  it("accepts null-prototype composition options", () => {
    const experimental = pack({
      meta: { ...pack().meta, status: "experimental" },
    });
    const options = Object.create(null) as { includeExperimental: boolean };
    options.includeExperimental = true;

    expect(composeRulePacks([experimental], options).rules).toHaveLength(1);
  });

  it("rejects malformed JavaScript composition options", () => {
    const malformedOptions = [
      null,
      [],
      "false",
      { includeExperimental: "false" },
      { unknown: true },
      { [Symbol("unknown")]: true },
    ];

    for (const options of malformedOptions) {
      expect(() => composeRulePacks([pack()], options as never)).toThrow(RulePackError);
    }
  });

  it("rejects reserved rule ids during composition", () => {
    for (const id of ["__proto__", "constructor", "prototype"]) {
      expect(() => composeRulePacks([pack({ rules: [buttonRule({ id })] })])).toThrow(
        RulePackError,
      );
    }
  });

  it("rejects sparse rule pack arrays with RulePackError field paths", () => {
    const sparseRules = new Array(1) as Rule[];
    expect(() => composeRulePacks([pack({ rules: sparseRules })])).toThrow(/rules\[0\]/);

    expect(() =>
      composeRulePacks([pack({ rules: [buttonRule({ tags: new Array(1) as string[] })] })]),
    ).toThrow(/rule\.meta\.tags\[0\]/);

    expect(() =>
      composeRulePacks([pack({ rules: [buttonRule({ references: new Array(1) as string[] })] })]),
    ).toThrow(/rule\.meta\.references\[0\]/);

    expect(() =>
      composeRulePacks([
        pack({ rules: [buttonRule({ appliesTo: new Array(1) as RuleMeta["appliesTo"] })] }),
      ]),
    ).toThrow(/rule\.meta\.appliesTo\[0\]/);

    expect(() =>
      composeRulePacks([
        pack({
          dictionary: {
            en: {
              example: new Array(1) as RegExp[],
            },
          },
        }),
      ]),
    ).toThrow(/dictionary\.en\.example\[0\]/);
  });

  it("snapshots mutable pack metadata, rules, and dictionaries", () => {
    const originalRule = buttonRule();
    const originalEvaluate = originalRule.evaluate;
    const dictionary: KeywordDictionary = { en: { cta: [/\bbuy\b/i] } };
    const mutablePack = pack({ rules: [originalRule], dictionary });
    const composed = composeRulePacks([mutablePack]);

    (mutablePack.meta as { id: string }).id = "changed/pack";
    (originalRule.meta as { id: string }).id = "changed/rule";
    (originalRule.meta.tags as string[]).push("changed");
    (mutablePack as unknown as { rules: Rule[] }).rules = [buttonRule({ id: "changed/array" })];
    (dictionary as { en?: KeywordDictionary["en"] }).en = { cta: [/\bnever\b/] };
    (originalRule as { evaluate: Rule["evaluate"] }).evaluate = () => [];

    expect(composed.rulePacks).toEqual([
      {
        id: "test/pack",
        version: "1.0.0",
        engineApiVersion: "1",
        title: "Test pack",
        description: undefined,
        status: "stable",
      },
    ]);
    expect(composed.rules.map((rule) => rule.meta.id)).toEqual(["test/button"]);
    expect(composed.rules[0]?.meta.tags).toEqual([]);
    expect(composed.dictionary.en?.cta?.[0]?.test("Buy now")).toBe(true);
    expect(composed.rules[0]?.evaluate).toBe(originalEvaluate);
  });
});

describe("createScanner", () => {
  it("matches legacy scan findings and adds provenance", () => {
    const rule = buttonRule();
    const rulePack = pack({ rules: [rule] });
    const legacy = scan(doc, [rule], { now: () => new Date("2026-01-01T00:00:00Z") });
    const scanner = createScanner({
      rulePacks: [rulePack],
      now: () => new Date("2026-01-01T00:00:00Z"),
    });

    const report = scanner.scan(doc);

    expect(report.findings).toEqual(legacy.findings);
    expect(report.summary).toEqual(legacy.summary);
    expect(report.rulePacks).toEqual([{ id: "test/pack", version: "1.0.0" }]);
    expect(Object.isFrozen(report.rulePacks)).toBe(true);
    expect(Object.isFrozen(report.rulePacks?.[0])).toBe(true);
    expect(scanner.rulePacks.map((meta) => meta.id)).toEqual(["test/pack"]);
  });

  it("applies severity overrides without changing fingerprints", () => {
    const rule = buttonRule();
    const before = createScanner({ rulePacks: [pack({ rules: [rule] })] }).scan(doc);
    const after = createScanner({
      rulePacks: [pack({ rules: [rule] })],
      severityOverrides: { "test/button": "high" },
    }).scan(doc);

    expect(after.findings[0]?.severity).toBe("high");
    expect(after.findings[0]?.fingerprint).toBe(before.findings[0]?.fingerprint);
  });

  it("applies rule overrides for existing surfaces", () => {
    const report = createScanner({
      rulePacks: [pack()],
      ruleOverrides: { "test/button": false },
    }).scan(doc);

    expect(report.summary.total).toBe(0);
  });

  it("keeps report references as strings after JSON serialization", () => {
    const scanner = createScanner({
      rulePacks: [pack({ rules: [buttonRule({ references: ["https://example.test/ref"] })] })],
    });
    const report = JSON.parse(JSON.stringify(scanner.scan(doc))) as {
      findings: Array<{ references?: unknown[] }>;
    };

    for (const finding of report.findings) {
      expect(finding.references?.every((value) => typeof value === "string") ?? true).toBe(true);
    }
  });

  it("keeps scanner results stable after source pack mutation", () => {
    const originalRule = buttonRule();
    const mutablePack = pack({
      rules: [originalRule],
      dictionary: { en: { cta: [/\bbuy\b/i] } },
    });
    const scanner = createScanner({
      rulePacks: [mutablePack],
      now: () => new Date("2026-01-01T00:00:00Z"),
    });
    const before = scanner.scan(doc);

    (mutablePack.meta as { version: string }).version = "9.9.9";
    (originalRule.meta as { id: string }).id = "changed/rule";
    (originalRule.meta.tags as string[]).push("changed");
    (mutablePack as unknown as { rules: Rule[] }).rules = [buttonRule({ id: "changed/array" })];
    (mutablePack as { dictionary: KeywordDictionary }).dictionary = { en: { cta: [/\bnever\b/] } };
    (originalRule as { evaluate: Rule["evaluate"] }).evaluate = () => [];

    const after = scanner.scan(doc);

    expect(after.findings).toEqual(before.findings);
    expect(after.rulePacks).toEqual([{ id: "test/pack", version: "1.0.0" }]);
    expect(scanner.rulePacks[0]?.version).toBe("1.0.0");
  });

  it("does not let report provenance mutation affect future scans", () => {
    const scanner = createScanner({
      rulePacks: [pack()],
      now: () => new Date("2026-01-01T00:00:00Z"),
    });
    const first = scanner.scan(doc);

    expect(() => {
      const firstPack = (first.rulePacks as unknown as Array<{ id: string }>)[0];
      if (!firstPack) throw new Error("missing rule pack provenance");
      firstPack.id = "forged/pack";
    }).toThrow();

    const second = scanner.scan(doc);

    expect(second.rulePacks).toEqual([{ id: "test/pack", version: "1.0.0" }]);
  });

  it("snapshots rule overrides when the scanner is created", () => {
    const override: Record<string, { severity: "low" | "high" }> = {
      "test/button": { severity: "low" },
    };
    const scanner = createScanner({
      rulePacks: [pack()],
      ruleOverrides: override,
      now: () => new Date("2026-01-01T00:00:00Z"),
    });
    const before = scanner.scan(doc);

    const buttonOverride = override["test/button"];
    if (!buttonOverride) throw new Error("missing button override");
    buttonOverride.severity = "high";
    override["test/button"] = { severity: "high" };
    const after = scanner.scan(doc);

    expect(before.findings[0]?.severity).toBe("low");
    expect(after.findings[0]?.severity).toBe("low");
    expect(after.findings[0]?.fingerprint).toBe(before.findings[0]?.fingerprint);
  });

  it("snapshots merged severity overrides when the scanner is created", () => {
    const ruleOverrides: Record<string, { enabled: boolean; severity: "low" | "medium" }> = {
      "test/button": { enabled: true, severity: "low" },
    };
    const severityOverrides: Record<string, "high" | "info"> = { "test/button": "high" };
    const scanner = createScanner({
      rulePacks: [pack()],
      ruleOverrides,
      severityOverrides,
      now: () => new Date("2026-01-01T00:00:00Z"),
    });
    const before = scanner.scan(doc);

    const buttonOverride = ruleOverrides["test/button"];
    if (!buttonOverride) throw new Error("missing button override");
    buttonOverride.enabled = false;
    buttonOverride.severity = "medium";
    severityOverrides["test/button"] = "info";
    const after = scanner.scan(doc);

    expect(before.findings[0]?.severity).toBe("high");
    expect(after.findings[0]?.severity).toBe("high");
    expect(after.findings[0]?.fingerprint).toBe(before.findings[0]?.fingerprint);
  });
});
