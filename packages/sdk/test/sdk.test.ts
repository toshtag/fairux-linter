import { parseHtml } from "@fairux/html";
import { Window } from "happy-dom";
import { describe, expect, it } from "vitest";
import { createDomScanner, scanDom } from "../src/dom.js";
import { createHtmlScanner, scanHtml } from "../src/html.js";
import {
  composeRulePacks,
  createScanner,
  FAIRUX_SDK_VERSION,
  fairuxBuiltinRulePack,
  InputTooLargeError,
  MAX_INPUT_BYTES,
  type Rule,
  type RuleOverride,
  type RulePack,
  RulePackError,
  ScannerPolicyError,
} from "../src/index.js";

const FIXED_NOW = () => new Date("2026-01-01T00:00:00Z");
const CHECKED_CONSENT_HTML =
  '<label><input type="checkbox" checked> Receive promotional email</label>';
const IMBALANCED_CONSENT_HTML = `<main><p>We use cookies.</p>
  <button class="btn-primary">Accept</button>
  <a href="#" class="link">Reject</a></main>`;
const DICTIONARY_CONSTRUCTOR_GROUP = "constructor";
const DICTIONARY_TO_STRING_GROUP = "toString";
const DICTIONARY_PROTO_GROUP = "__proto__";

const customRulePack: RulePack = {
  meta: {
    id: "example/custom-pack",
    version: "0.0.0-test.0",
    engineApiVersion: "1",
    title: "Custom test pack",
    status: "experimental",
  },
  rules: [
    {
      meta: {
        id: "example/missing-return-policy",
        title: "Missing return policy",
        category: "hidden-cost",
        defaultSeverity: "low",
        defaultConfidence: "medium",
        defaultEnabled: true,
        tags: ["purchase-guard"],
        version: "1.0.0",
      },
      evaluate(doc, ctx) {
        const hasReturnPolicy = doc
          .all()
          .some((node) => /return policy|返品/.test(node.normalizedText));
        if (hasReturnPolicy) return [];
        return [
          ctx.createFinding({
            evidence: [{ locator: doc.root.locator, text: doc.root.subtreeText }],
            description: "No return policy copy was found.",
            whyItMatters: "Return terms are a consumer-protection signal.",
            recommendation: "Link to the return policy near checkout.",
          }),
        ];
      },
    },
  ],
};

function dictionaryRulePack(): RulePack {
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
  Object.defineProperty(group, "__proto__", {
    value: [/gamma/],
    enumerable: true,
    configurable: true,
  });
  return {
    meta: {
      id: "example/dictionary-pack",
      version: "0.0.0-test.0",
      engineApiVersion: "1",
      title: "Dictionary test pack",
      status: "stable",
    },
    dictionary: { en: group },
    rules: [
      {
        meta: {
          id: "example/prototype-dictionary",
          title: "Prototype dictionary",
          category: "obstruction",
          defaultSeverity: "low",
          defaultConfidence: "low",
          defaultEnabled: true,
          tags: [],
          version: "1.0.0",
        },
        evaluate(doc, ctx) {
          const dictionary = ctx.getDictionary();
          const matched =
            ctx.text.hasAny(doc.root.subtreeText, dictionary[DICTIONARY_CONSTRUCTOR_GROUP] ?? []) &&
            ctx.text.hasAny(doc.root.subtreeText, dictionary[DICTIONARY_TO_STRING_GROUP] ?? []) &&
            ctx.text.hasAny(doc.root.subtreeText, dictionary[DICTIONARY_PROTO_GROUP] ?? []);
          if (!matched) return [];
          return [
            ctx.createFinding({
              evidence: [{ locator: doc.root.locator, text: doc.root.subtreeText }],
              description: "Prototype-sensitive dictionary groups matched.",
              whyItMatters: "Dictionary keys should not collide with Object.prototype.",
              recommendation: "Keep prototype-safe dictionary maps.",
            }),
          ];
        },
      },
    ],
  };
}

function findingByRule<T extends { readonly ruleId: string }>(
  report: { readonly findings: readonly T[] },
  ruleId: string,
): T | undefined {
  return report.findings.find((finding) => finding.ruleId === ruleId);
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

describe("@fairux/sdk", () => {
  it("exports the core scanner facade and built-in pack", () => {
    const composed = composeRulePacks([fairuxBuiltinRulePack]);
    const scanner = createScanner({ rulePacks: [fairuxBuiltinRulePack] });

    expect(composed.rulePacks[0]?.id).toBe("@fairux/builtin");
    expect(scanner.rulePacks[0]?.id).toBe("@fairux/builtin");
  });

  it("validates rule pack composition options at the SDK root", () => {
    expect(() =>
      composeRulePacks([fairuxBuiltinRulePack], {
        includeExperimental: "false",
      } as never),
    ).toThrow(RulePackError);
  });

  it("defaults report toolVersion to the SDK package version", () => {
    const report = scanHtml("<main><button>Buy now</button></main>", {
      now: () => new Date("2026-01-01T00:00:00Z"),
    });

    expect(report.toolVersion).toBe(FAIRUX_SDK_VERSION);
  });

  it("preserves an explicit report toolVersion override", () => {
    const report = scanHtml("<main><button>Buy now</button></main>", {
      now: () => new Date("2026-01-01T00:00:00Z"),
      toolVersion: "consumer-product/2.3.4",
    });

    expect(report.toolVersion).toBe("consumer-product/2.3.4");
  });

  it("scans static HTML with the built-in pack by default", () => {
    const report = scanHtml(CHECKED_CONSENT_HTML, { now: FIXED_NOW });

    expect(report.summary.total).toBeGreaterThan(0);
    expect(report.rulePacks).toEqual([{ id: "@fairux/builtin", version: "0.1.0" }]);
  });

  it("protects the public built-in pack from consumer mutation", () => {
    const before = scanHtml(CHECKED_CONSENT_HTML, { now: FIXED_NOW });
    const beforeFinding = findingByRule(before, "consent/checked-checkbox");
    const originalPackId = fairuxBuiltinRulePack.meta.id;
    const originalVersion = fairuxBuiltinRulePack.meta.version;
    const originalEvaluate = fairuxBuiltinRulePack.rules[0]?.evaluate;
    const customRule = customRulePack.rules[0];
    expect(customRule).toBeDefined();

    expect(Object.isFrozen(fairuxBuiltinRulePack)).toBe(true);
    expect(Object.isFrozen(fairuxBuiltinRulePack.meta)).toBe(true);
    expect(Object.isFrozen(fairuxBuiltinRulePack.rules)).toBe(true);
    expect(Object.isFrozen(fairuxBuiltinRulePack.rules[0])).toBe(true);
    expect(Object.isFrozen(fairuxBuiltinRulePack.rules[0]?.meta)).toBe(true);
    expect(Object.isFrozen(fairuxBuiltinRulePack.dictionary)).toBe(true);

    expect(() => {
      (fairuxBuiltinRulePack.meta as { id: string }).id = "forged/builtin";
    }).toThrow();
    expect(() => {
      (fairuxBuiltinRulePack.meta as { version: string }).version = "999.0.0";
    }).toThrow();
    expect(() => {
      (fairuxBuiltinRulePack.rules as Rule[]).push(customRule as Rule);
    }).toThrow();
    expect(() => {
      (fairuxBuiltinRulePack.rules[0] as { evaluate: Rule["evaluate"] }).evaluate = () => [];
    }).toThrow();

    const after = scanHtml(CHECKED_CONSENT_HTML, { now: FIXED_NOW });
    const afterFinding = findingByRule(after, "consent/checked-checkbox");

    expect(fairuxBuiltinRulePack.meta.id).toBe(originalPackId);
    expect(fairuxBuiltinRulePack.meta.version).toBe(originalVersion);
    expect(fairuxBuiltinRulePack.rules[0]?.evaluate).toBe(originalEvaluate);
    expect(before.rulePacks).toEqual([{ id: "@fairux/builtin", version: "0.1.0" }]);
    expect(after.rulePacks).toEqual([{ id: "@fairux/builtin", version: "0.1.0" }]);
    expect(beforeFinding).toBeDefined();
    expect(afterFinding).toBeDefined();
    expect(afterFinding?.fingerprint).toBe(beforeFinding?.fingerprint);
  });

  it("applies HTML scanner rule overrides the same way as the core scanner", () => {
    const disabled = scanHtml(CHECKED_CONSENT_HTML, {
      ruleOverrides: { "consent/checked-checkbox": false },
      now: FIXED_NOW,
    });
    const experimental = scanHtml(IMBALANCED_CONSENT_HTML, {
      ruleOverrides: { "consent/accept-reject-visual-imbalance": { enabled: true } },
      now: FIXED_NOW,
    });
    const baseline = scanHtml(CHECKED_CONSENT_HTML, { now: FIXED_NOW });
    const severityOverride = scanHtml(CHECKED_CONSENT_HTML, {
      severityOverrides: { "consent/checked-checkbox": "low" },
      now: FIXED_NOW,
    });
    const baselineFinding = findingByRule(baseline, "consent/checked-checkbox");
    const overriddenFinding = findingByRule(severityOverride, "consent/checked-checkbox");

    expect(findingByRule(disabled, "consent/checked-checkbox")).toBeUndefined();
    expect(findingByRule(experimental, "consent/accept-reject-visual-imbalance")).toBeDefined();
    expect(overriddenFinding?.severity).toBe("low");
    expect(overriddenFinding?.fingerprint).toBe(baselineFinding?.fingerprint);
  });

  it("rejects unknown rule ids across root, HTML, and DOM scanner APIs", () => {
    const window = new Window();
    window.document.body.innerHTML = CHECKED_CONSENT_HTML;

    expect(() =>
      createScanner({
        rulePacks: [fairuxBuiltinRulePack],
        ruleOverrides: { "consent/checked-chekbox": false },
      }),
    ).toThrow(ScannerPolicyError);
    expect(() =>
      scanHtml(CHECKED_CONSENT_HTML, {
        ruleOverrides: { "consent/checked-chekbox": false },
      }),
    ).toThrow(ScannerPolicyError);
    expect(() =>
      createHtmlScanner({
        severityOverrides: { "consent/checked-chekbox": "low" },
      }),
    ).toThrow(ScannerPolicyError);
    expect(() =>
      scanDom(window.document as unknown as Document, {
        ruleOverrides: { "consent/checked-chekbox": false },
      }),
    ).toThrow(ScannerPolicyError);
    expect(() =>
      createDomScanner({
        severityOverrides: { "consent/checked-chekbox": "low" },
      }),
    ).toThrow(ScannerPolicyError);
  });

  it("accepts known built-in and custom rule ids only from configured packs", () => {
    expect(() =>
      createHtmlScanner({
        ruleOverrides: { "consent/checked-checkbox": false },
      }),
    ).not.toThrow();
    expect(() =>
      createHtmlScanner({
        ruleOverrides: { "example/missing-return-policy": false },
      }),
    ).toThrow(ScannerPolicyError);
    expect(() =>
      createHtmlScanner({
        includeExperimental: true,
        rulePacks: [fairuxBuiltinRulePack, customRulePack],
        ruleOverrides: { "example/missing-return-policy": false },
      }),
    ).not.toThrow();
  });

  it("normalizes malformed public option objects to ScannerPolicyError", () => {
    expect(() => createScanner(null as never)).toThrow(ScannerPolicyError);
    expect(() => createScanner("bad" as never)).toThrow(ScannerPolicyError);
    expect(() => createScanner(new Date() as never)).toThrow(ScannerPolicyError);
    expect(() => createScanner(new Map() as never)).toThrow(ScannerPolicyError);
    expect(() =>
      createScanner({
        rulePacks: [fairuxBuiltinRulePack],
        includeExperimantal: true,
      } as never),
    ).toThrow(ScannerPolicyError);
    expect(() =>
      createScanner({
        rulePacks: [fairuxBuiltinRulePack],
        toolVersion: null,
      } as never),
    ).toThrow(ScannerPolicyError);
    expect(() =>
      createScanner({
        rulePacks: [fairuxBuiltinRulePack],
        [Symbol("unknown")]: true,
      } as never),
    ).toThrow(ScannerPolicyError);
    expect(() => createHtmlScanner(null as never)).toThrow(ScannerPolicyError);
    expect(() => createHtmlScanner(new Date() as never)).toThrow(ScannerPolicyError);
    expect(() => createHtmlScanner({ rulePacks: null } as never)).toThrow(ScannerPolicyError);
    expect(() => createHtmlScanner({ includeExperimantal: true } as never)).toThrow(
      ScannerPolicyError,
    );
    expect(() => scanHtml(CHECKED_CONSENT_HTML, null as never)).toThrow(ScannerPolicyError);
    expect(() => scanHtml(CHECKED_CONSENT_HTML, { filepath: "checkout.html" } as never)).toThrow(
      ScannerPolicyError,
    );

    const window = new Window();
    window.document.body.innerHTML = CHECKED_CONSENT_HTML;
    expect(() => createDomScanner(null as never)).toThrow(ScannerPolicyError);
    expect(() => createDomScanner({ severityOverride: {} } as never)).toThrow(ScannerPolicyError);
    expect(() => scanDom(window.document as unknown as Document, null as never)).toThrow(
      ScannerPolicyError,
    );
    expect(() =>
      scanDom(window.document as unknown as Document, { roots: window.document.body } as never),
    ).toThrow(ScannerPolicyError);
  });

  it("applies SDK defaults only for undefined values", () => {
    const rootScanner = createScanner({
      rulePacks: [fairuxBuiltinRulePack],
      toolVersion: undefined,
    });
    const htmlScanner = createHtmlScanner({});
    const domScanner = createDomScanner({ rulePacks: undefined });

    expect(rootScanner.scan(parseHtml(CHECKED_CONSENT_HTML)).toolVersion).toBe(FAIRUX_SDK_VERSION);
    expect(htmlScanner.rulePacks[0]?.id).toBe("@fairux/builtin");
    expect(domScanner.rulePacks[0]?.id).toBe("@fairux/builtin");
  });

  it("validates reusable HTML and DOM per-scan options", () => {
    const htmlScanner = createHtmlScanner();
    const window = new Window();
    window.document.body.innerHTML = `<section id="target">${CHECKED_CONSENT_HTML}</section>`;
    const domScanner = createDomScanner();
    const target = window.document.querySelector("#target");
    expect(target).toBeDefined();

    expect(() => htmlScanner.scan(CHECKED_CONSENT_HTML, new Date() as never)).toThrow(
      ScannerPolicyError,
    );
    expect(() =>
      htmlScanner.scan(CHECKED_CONSENT_HTML, { filepath: "checkout.html" } as never),
    ).toThrow(ScannerPolicyError);
    expect(() => htmlScanner.scan(CHECKED_CONSENT_HTML, { file: null } as never)).toThrow(
      ScannerPolicyError,
    );
    expect(() =>
      domScanner.scan(window.document as unknown as Document, { roots: target } as never),
    ).toThrow(ScannerPolicyError);
    expect(() =>
      domScanner.scan(window.document as unknown as Document, { root: null } as never),
    ).toThrow(ScannerPolicyError);
    expect(() =>
      domScanner.scan(window.document as unknown as Document, { url: null } as never),
    ).toThrow(ScannerPolicyError);
  });

  it("creates reusable HTML scanners with snapshotted policy and pack composition", () => {
    const ruleOverrides: Record<string, boolean | RuleOverride> = {
      "consent/checked-checkbox": false,
    };
    const mutablePack: RulePack = {
      ...customRulePack,
      rules: [...customRulePack.rules],
    };
    const scanner = createHtmlScanner({
      includeExperimental: true,
      rulePacks: [fairuxBuiltinRulePack, mutablePack],
      ruleOverrides,
      now: FIXED_NOW,
    });
    const originalEvaluate = mutablePack.rules[0]?.evaluate;
    expect(originalEvaluate).toBeDefined();

    ruleOverrides["consent/checked-checkbox"] = true;
    (mutablePack.rules as Rule[])[0] = {
      ...(mutablePack.rules[0] as Rule),
      evaluate: () => [],
    };

    const first = scanner.scan(CHECKED_CONSENT_HTML, { file: "first.html" });
    const second = scanner.scan("<main><button>Buy now</button></main>", { file: "second.html" });

    expect(Object.isFrozen(scanner)).toBe(true);
    expect(first.input.file).toBe("first.html");
    expect(second.input.file).toBe("second.html");
    expect(findingByRule(first, "consent/checked-checkbox")).toBeUndefined();
    expect(findingByRule(second, "example/missing-return-policy")).toBeDefined();
    expect(scanner.rulePacks.map((pack) => `${pack.id}@${pack.version}`)).toEqual([
      "@fairux/builtin@0.1.0",
      "example/custom-pack@0.0.0-test.0",
    ]);
  });

  it("matches one-shot HTML reports when using an equivalent reusable scanner", () => {
    const oneShot = scanHtml(CHECKED_CONSENT_HTML, {
      file: "same.html",
      now: FIXED_NOW,
    });
    const reusable = createHtmlScanner({ now: FIXED_NOW }).scan(CHECKED_CONSENT_HTML, {
      file: "same.html",
    });
    const oneShotFinding = findingByRule(oneShot, "consent/checked-checkbox");
    const reusableFinding = findingByRule(reusable, "consent/checked-checkbox");

    expect(reusable.rulePacks).toEqual(oneShot.rulePacks);
    expect(reusable.summary).toEqual(oneShot.summary);
    expect(reusableFinding?.fingerprint).toBe(oneShotFinding?.fingerprint);
  });

  it("composes custom packs for static HTML", () => {
    const report = scanHtml("<main><button>Buy now</button></main>", {
      includeExperimental: true,
      rulePacks: [fairuxBuiltinRulePack, customRulePack],
      ruleOverrides: { "example/missing-return-policy": { severity: "medium" } },
      now: FIXED_NOW,
    });

    expect(report.rulePacks).toEqual([
      { id: "@fairux/builtin", version: "0.1.0" },
      { id: "example/custom-pack", version: "0.0.0-test.0" },
    ]);
    expect(
      report.findings.some((finding) => finding.ruleId === "example/missing-return-policy"),
    ).toBe(true);
    expect(findingByRule(report, "example/missing-return-policy")?.severity).toBe("medium");
  });

  it("supports prototype-sensitive custom dictionary groups", () => {
    const report = scanHtml("<main>alpha beta gamma</main>", {
      rulePacks: [fairuxBuiltinRulePack, dictionaryRulePack()],
      now: FIXED_NOW,
    });

    expect(findingByRule(report, "example/prototype-dictionary")).toBeDefined();
  });

  it("rejects malformed custom rule pack data through the SDK", () => {
    const dictionaryPack = dictionaryRulePack();
    const dictionaryRule = dictionaryPack.rules[0];
    if (!dictionaryRule) throw new Error("dictionary rule fixture is missing");
    const inheritedMeta = Object.create(dictionaryPack.meta) as RulePack["meta"];

    expect(() =>
      composeRulePacks([
        {
          ...dictionaryPack,
          dictionary: null,
        } as never,
      ]),
    ).toThrow(RulePackError);
    expect(() =>
      composeRulePacks([
        {
          ...dictionaryPack,
          rules: new Array(1),
        } as never,
      ]),
    ).toThrow(RulePackError);
    expect(() =>
      composeRulePacks([
        {
          ...dictionaryPack,
          rules: [
            {
              ...dictionaryRule,
              meta: {
                ...dictionaryRule.meta,
                references: new Array(1),
              },
            },
          ],
        } as never,
      ]),
    ).toThrow(RulePackError);
    expect(() =>
      composeRulePacks([
        {
          ...dictionaryPack,
          dictionry: dictionaryPack.dictionary,
        } as never,
      ]),
    ).toThrow(RulePackError);
    expect(() =>
      composeRulePacks([
        {
          ...dictionaryPack,
          meta: {
            ...dictionaryPack.meta,
            experimentl: true,
          },
        } as never,
      ]),
    ).toThrow(RulePackError);
    expect(() =>
      composeRulePacks([
        {
          ...dictionaryPack,
          meta: inheritedMeta,
        } as never,
      ]),
    ).toThrow(RulePackError);
  });

  it("rejects malformed custom rule findings through the SDK", () => {
    const customRule = customRulePack.rules[0];
    if (!customRule) throw new Error("custom rule fixture is missing");
    const malformedPack: RulePack = {
      ...dictionaryRulePack(),
      meta: {
        ...dictionaryRulePack().meta,
        id: "example/malformed-finding-pack",
      },
      rules: [
        {
          ...customRule,
          meta: {
            ...customRule.meta,
            id: "example/malformed-finding",
          },
          evaluate(doc, ctx) {
            return [
              ctx.createFinding({
                severity: "critical" as never,
                evidence: [{ locator: doc.root.locator, text: doc.root.subtreeText }],
                description: "Invalid severity.",
                whyItMatters: "Rule output must preserve the public report schema.",
                recommendation: "Return a valid severity.",
              }),
            ];
          },
        },
      ],
    };

    expect(() =>
      scanHtml("<main>alpha beta gamma</main>", {
        rulePacks: [fairuxBuiltinRulePack, malformedPack],
        now: FIXED_NOW,
      }),
    ).toThrow(RulePackError);
  });

  it("rejects category-mismatched and duplicate custom findings through the SDK", () => {
    const customRule = customRulePack.rules[0];
    if (!customRule) throw new Error("custom rule fixture is missing");
    const categoryMismatchPack: RulePack = {
      ...customRulePack,
      meta: { ...customRulePack.meta, id: "example/category-mismatch-pack", status: "stable" },
      rules: [
        {
          ...customRule,
          meta: { ...customRule.meta, id: "example/category-mismatch" },
          evaluate(doc, ctx) {
            const finding = ctx.createFinding({
              evidence: [{ locator: doc.root.locator, text: doc.root.subtreeText }],
              description: "Wrong category.",
              whyItMatters: "Rule output must match its declared metadata.",
              recommendation: "Return the rule meta category.",
            });
            return [{ ...finding, category: "privacy" as never }];
          },
        },
      ],
    };
    const duplicateIdPack: RulePack = {
      ...customRulePack,
      meta: { ...customRulePack.meta, id: "example/duplicate-id-pack", status: "stable" },
      rules: [
        {
          ...customRule,
          meta: { ...customRule.meta, id: "example/duplicate-id" },
          evaluate(doc, ctx) {
            const first = ctx.createFinding({
              evidence: [{ locator: doc.root.locator, text: "first" }],
              description: "Duplicate id.",
              whyItMatters: "Report finding ids must be unique.",
              recommendation: "Let createFinding allocate ids or provide unique ids.",
            });
            const second = ctx.createFinding({
              evidence: [{ locator: doc.root.locator, text: "second" }],
              description: "Duplicate id.",
              whyItMatters: "Report finding ids must be unique.",
              recommendation: "Let createFinding allocate ids or provide unique ids.",
            });
            return [
              { ...first, id: "duplicate" },
              { ...second, id: "duplicate" },
            ];
          },
        },
      ],
    };

    expect(() =>
      scanHtml("<main>alpha beta gamma</main>", {
        rulePacks: [categoryMismatchPack],
        now: FIXED_NOW,
      }),
    ).toThrow(RulePackError);
    expect(() =>
      scanHtml("<main>alpha beta gamma</main>", {
        rulePacks: [duplicateIdPack],
        now: FIXED_NOW,
      }),
    ).toThrow(RulePackError);
  });

  it("snapshots getter-backed custom findings through the SDK", () => {
    const customRule = customRulePack.rules[0];
    if (!customRule) throw new Error("custom rule fixture is missing");
    let reads = 0;
    const getterBackedPack: RulePack = {
      ...customRulePack,
      meta: { ...customRulePack.meta, id: "example/getter-backed-pack", status: "stable" },
      rules: [
        {
          ...customRule,
          meta: {
            ...customRule.meta,
            id: "example/getter-backed",
            defaultSeverity: "high",
          },
          evaluate(doc, ctx) {
            const finding = {
              ...ctx.createFinding({
                evidence: [{ locator: doc.root.locator, text: doc.root.subtreeText }],
                description: "Getter-backed severity.",
                whyItMatters: "Rule output must be snapshotted before aggregation.",
                recommendation: "Return plain data objects.",
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
        },
      ],
    };

    const report = scanHtml("<main>alpha beta gamma</main>", {
      rulePacks: [getterBackedPack],
      now: FIXED_NOW,
    });

    expect(report.findings[0]?.severity).toBe("high");
    expect(report.summary.bySeverity.high).toBe(1);
    expect((report.summary.bySeverity as Record<string, number>).critical).toBeUndefined();
    expect(Object.values(report.summary.bySeverity).every(Number.isFinite)).toBe(true);
    expect(reads).toBe(1);
  });

  it("rejects optional getter bypasses through the SDK", () => {
    const customRule = customRulePack.rules[0];
    if (!customRule) throw new Error("custom rule fixture is missing");
    let evidenceTextReads = 0;
    let batchOccurrenceReads = 0;
    const evidenceTextPack: RulePack = {
      ...customRulePack,
      meta: { ...customRulePack.meta, id: "example/evidence-text-getter-pack", status: "stable" },
      rules: [
        {
          ...customRule,
          meta: { ...customRule.meta, id: "example/evidence-text-getter" },
          evaluate(doc, ctx) {
            const evidence = { locator: doc.root.locator };
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
                description: "Changing evidence text.",
                whyItMatters: "Rule output must be snapshotted before aggregation.",
                recommendation: "Return a valid string.",
              }),
            ];
          },
        },
      ],
    };
    const batchOccurrencePack: RulePack = {
      ...customRulePack,
      meta: { ...customRulePack.meta, id: "example/batch-getter-pack", status: "stable" },
      rules: [
        {
          ...customRule,
          meta: { ...customRule.meta, id: "example/batch-getter" },
          evaluate(doc, ctx) {
            const finding = {
              ...ctx.createFinding({
                evidence: [{ locator: doc.root.locator, text: doc.root.subtreeText }],
                description: "Changing batch occurrence.",
                whyItMatters: "Rule output must be snapshotted before aggregation.",
                recommendation: "Return a valid string.",
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
        },
      ],
    };

    expectRulePackError(
      () =>
        scanHtml("<main>alpha beta gamma</main>", {
          rulePacks: [evidenceTextPack],
          now: FIXED_NOW,
        }),
      "text.normalize",
    );
    expectRulePackError(() =>
      scanHtml("<main>alpha beta gamma</main>", {
        rulePacks: [batchOccurrencePack],
        now: FIXED_NOW,
      }),
    );
    expect(evidenceTextReads).toBe(1);
    expect(batchOccurrenceReads).toBe(1);
  });

  it("scans a live DOM document", () => {
    const window = new Window();
    window.document.body.innerHTML = CHECKED_CONSENT_HTML;

    const report = scanDom(window.document as unknown as Document, {
      now: FIXED_NOW,
    });

    expect(report.input.runtime).toBe("dom");
    expect(report.summary.total).toBeGreaterThan(0);
  });

  it("applies DOM scanner rule overrides the same way as static HTML", () => {
    const disabledWindow = new Window();
    disabledWindow.document.body.innerHTML = CHECKED_CONSENT_HTML;
    const experimentalWindow = new Window();
    experimentalWindow.document.body.innerHTML = IMBALANCED_CONSENT_HTML;
    const baselineWindow = new Window();
    baselineWindow.document.body.innerHTML = CHECKED_CONSENT_HTML;
    const severityWindow = new Window();
    severityWindow.document.body.innerHTML = CHECKED_CONSENT_HTML;

    const disabled = scanDom(disabledWindow.document as unknown as Document, {
      ruleOverrides: { "consent/checked-checkbox": false },
      now: FIXED_NOW,
    });
    const experimental = scanDom(experimentalWindow.document as unknown as Document, {
      ruleOverrides: { "consent/accept-reject-visual-imbalance": { enabled: true } },
      now: FIXED_NOW,
    });
    const baseline = scanDom(baselineWindow.document as unknown as Document, { now: FIXED_NOW });
    const severityOverride = scanDom(severityWindow.document as unknown as Document, {
      severityOverrides: { "consent/checked-checkbox": "low" },
      now: FIXED_NOW,
    });
    const baselineFinding = findingByRule(baseline, "consent/checked-checkbox");
    const overriddenFinding = findingByRule(severityOverride, "consent/checked-checkbox");

    expect(findingByRule(disabled, "consent/checked-checkbox")).toBeUndefined();
    expect(findingByRule(experimental, "consent/accept-reject-visual-imbalance")).toBeDefined();
    expect(overriddenFinding?.severity).toBe("low");
    expect(overriddenFinding?.fingerprint).toBe(baselineFinding?.fingerprint);
  });

  it("creates reusable DOM scanners with per-scan root options", () => {
    const window = new Window();
    window.document.body.innerHTML = `<section id="first">${CHECKED_CONSENT_HTML}</section>
      <section id="second"><p>No consent controls here.</p></section>`;
    const scanner = createDomScanner({ now: FIXED_NOW });
    const firstRoot = window.document.querySelector("#first");
    const secondRoot = window.document.querySelector("#second");
    expect(firstRoot).toBeDefined();
    expect(secondRoot).toBeDefined();

    const first = scanner.scan(window.document as unknown as Document, {
      root: firstRoot as unknown as Element,
      url: "https://example.test/first",
    });
    const second = scanner.scan(window.document as unknown as Document, {
      root: secondRoot as unknown as Element,
      url: "https://example.test/second",
    });

    expect(Object.isFrozen(scanner)).toBe(true);
    expect(findingByRule(first, "consent/checked-checkbox")).toBeDefined();
    expect(findingByRule(second, "consent/checked-checkbox")).toBeUndefined();
    expect(first.rulePacks).toEqual([{ id: "@fairux/builtin", version: "0.1.0" }]);
    expect(second.rulePacks).toEqual(first.rulePacks);
  });

  it("rejects oversized ASCII HTML before scanning", () => {
    const html = "x".repeat(MAX_INPUT_BYTES + 1);

    expect(() => scanHtml(html)).toThrow(InputTooLargeError);
    try {
      scanHtml(html);
    } catch (error) {
      expect(error).toBeInstanceOf(InputTooLargeError);
      expect((error as InstanceType<typeof InputTooLargeError>).kind).toBe("bytes");
      expect((error as InstanceType<typeof InputTooLargeError>).actual).toBe(MAX_INPUT_BYTES + 1);
    }
  });

  it("rejects oversized UTF-8 HTML by bytes, not JavaScript string length", () => {
    const html = "あ".repeat(Math.floor(MAX_INPUT_BYTES / 3) + 1);

    expect(html.length).toBeLessThan(MAX_INPUT_BYTES);
    expect(() => scanHtml(html)).toThrow(InputTooLargeError);
  });
});
