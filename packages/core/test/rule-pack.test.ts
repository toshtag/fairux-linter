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

  it("requires public governance metadata on every rule", () => {
    expect(() =>
      composeRulePacks([
        pack({
          rules: [
            {
              ...buttonRule(),
              meta: {
                id: "test/missing-governance",
                title: "Missing governance",
                category: "obstruction",
                defaultSeverity: "low",
                defaultConfidence: "low",
                defaultEnabled: true,
                tags: [],
                version: "1.0.0",
              } as unknown as RuleMeta,
            },
          ],
        }),
      ]),
    ).toThrow(/invalid maturity/);
  });

  it("enforces RulePack status and RuleMaturity acceptance matrix", () => {
    expect(() =>
      composeRulePacks([
        pack({
          rules: [
            buttonRule({
              id: "test/stable-pack-draft",
              maturity: "draft",
              experimental: true,
              defaultEnabled: false,
            }),
          ],
        }),
      ]),
    ).toThrow(/stable RulePacks must not contain draft rules/);

    expect(() =>
      composeRulePacks(
        [
          pack({
            meta: { ...pack().meta, status: "experimental" },
            rules: [
              buttonRule({
                id: "test/experimental-pack-draft",
                maturity: "draft",
                experimental: true,
                defaultEnabled: false,
              }),
            ],
          }),
        ],
        { includeExperimental: true },
      ),
    ).not.toThrow();
  });

  it("rejects malformed governance before experimental pack exclusion", () => {
    expect(() =>
      composeRulePacks(
        [
          pack({
            meta: { ...pack().meta, status: "experimental" },
            rules: [
              buttonRule({
                id: "test/excluded-invalid-governance",
                requiredCapabilities: [] as never,
              }),
            ],
          }),
        ],
        { includeExperimental: false },
      ),
    ).toThrow(/rule\.meta\.requiredCapabilities/);

    expect(
      composeRulePacks(
        [
          pack({
            meta: { ...pack().meta, status: "experimental" },
            rules: [buttonRule({ id: "test/excluded-valid-governance" })],
          }),
        ],
        { includeExperimental: false },
      ).rules,
    ).toHaveLength(0);
  });

  it("enforces maturity runtime gates without changing deprecated gates", () => {
    for (const maturity of ["draft", "experimental"] as const) {
      expect(() =>
        composeRulePacks(
          [
            pack({
              meta: { ...pack().meta, status: "experimental" },
              rules: [
                buttonRule({
                  id: `test/${maturity}-without-experimental`,
                  maturity,
                  defaultEnabled: false,
                }),
              ],
            }),
          ],
          { includeExperimental: true },
        ),
      ).toThrow(/must use experimental: true/);

      expect(() =>
        composeRulePacks(
          [
            pack({
              meta: { ...pack().meta, status: "experimental" },
              rules: [
                buttonRule({
                  id: `test/${maturity}-default-enabled`,
                  maturity,
                  experimental: true,
                  defaultEnabled: true,
                }),
              ],
            }),
          ],
          { includeExperimental: true },
        ),
      ).toThrow(/must use defaultEnabled: false/);
    }

    expect(() =>
      composeRulePacks([
        pack({
          rules: [buttonRule({ maturity: "stable", experimental: true })],
        }),
      ]),
    ).toThrow(/stable maturity rules must not use experimental: true/);

    expect(() =>
      composeRulePacks([
        pack({
          rules: [
            buttonRule({
              id: "test/deprecated-non-experimental",
              maturity: "deprecated",
              defaultEnabled: true,
              deprecation: { since: "1.0.0", reason: "Superseded by a stricter rule." },
            }),
            buttonRule({
              id: "test/deprecated-experimental",
              maturity: "deprecated",
              experimental: true,
              defaultEnabled: false,
              deprecation: { since: "1.0.0", reason: "Experimental signal retired." },
            }),
          ],
        }),
      ]),
    ).not.toThrow();
  });

  it("requires deprecation metadata only for deprecated rules", () => {
    expect(() =>
      composeRulePacks([
        pack({
          rules: [buttonRule({ maturity: "deprecated" })],
        }),
      ]),
    ).toThrow(/deprecated rules require deprecation metadata/);

    expect(() =>
      composeRulePacks([
        pack({
          rules: [
            buttonRule({
              maturity: "stable",
              deprecation: { since: "1.0.0", reason: "Not actually deprecated." },
            }),
          ],
        }),
      ]),
    ).toThrow(/non-deprecated rules must not carry deprecation metadata/);
  });

  it("validates capability ids and evidence requirements", () => {
    expect(() =>
      composeRulePacks([
        pack({
          rules: [buttonRule({ requiredCapabilities: [] as never })],
        }),
      ]),
    ).toThrow(/rule\.meta\.requiredCapabilities/);

    expect(() =>
      composeRulePacks([
        pack({
          rules: [buttonRule({ requiredCapabilities: [`browser/${"computed-style"}`] })],
        }),
      ]),
    ).toThrow(/built-in capability id or namespaced capability id/);

    expect(() =>
      composeRulePacks([
        pack({
          rules: [buttonRule({ requiredCapabilities: ["browser/paint-order"] })],
        }),
      ]),
    ).not.toThrow();

    expect(() =>
      composeRulePacks([
        pack({
          rules: [buttonRule({ requiredCapabilities: ["computed style" as never] })],
        }),
      ]),
    ).toThrow(/built-in capability id or namespaced capability id/);

    expect(() =>
      composeRulePacks([
        pack({
          rules: [
            buttonRule({
              requiredCapabilities: ["structure"],
              optionalCapabilities: ["structure"],
            }),
          ],
        }),
      ]),
    ).toThrow(/must not overlap/);

    expect(() =>
      composeRulePacks([
        pack({
          rules: [buttonRule({ evidenceRequirements: ["screenshot" as never] })],
        }),
      ]),
    ).toThrow(/expected one of/);

    for (const overrides of [
      { optionalCapabilities: [] },
      { evidenceRequirements: [] },
      { jurisdictions: [] },
      { officialSources: [] },
      { knownLimitations: [] },
      { requiredCapabilities: ["structure", "structure"] },
      { evidenceRequirements: ["presence", "presence"] },
      { jurisdictions: ["US", "US"] },
      { knownLimitations: ["Static only.", "Static only."] },
    ] as Array<Partial<RuleMeta>>) {
      expect(() =>
        composeRulePacks([
          pack({
            rules: [buttonRule({ id: `test/invalid-${Object.keys(overrides)[0]}`, ...overrides })],
          }),
        ]),
      ).toThrow(RulePackError);
    }
  });

  it("validates official source identity and jurisdiction metadata", () => {
    const source = {
      id: "regulator/ftc-negative-option",
      title: "Negative option guidance",
      publisher: "FTC",
      url: "https://www.ftc.gov/business-guidance/",
      jurisdictions: ["US", "EU", "toshtag/private-beta"],
      reviewedAt: "2026-07-22",
    } as const;
    const composed = composeRulePacks([
      pack({
        rules: [
          buttonRule({
            id: "test/with-source",
            officialSources: [source],
            jurisdictions: ["US", "global"],
          }),
        ],
      }),
    ]);

    expect(composed.rules[0]?.meta.officialSources?.[0]?.url).toBe(
      "https://www.ftc.gov/business-guidance/",
    );

    expect(() =>
      composeRulePacks([
        pack({
          rules: [
            buttonRule({
              officialSources: [
                {
                  ...source,
                  id: "bad-source" as never,
                },
              ],
            }),
          ],
        }),
      ]),
    ).toThrow(/expected a namespaced id/);

    expect(() =>
      composeRulePacks([
        pack({
          rules: [buttonRule({ jurisdictions: ["United States"] })],
        }),
      ]),
    ).toThrow(/expected global, EU, EEA/);

    expect(() =>
      composeRulePacks([
        pack({
          rules: [
            buttonRule({
              officialSources: [
                source,
                {
                  ...source,
                  id: "regulator/ftc-alt",
                  url: "https://www.ftc.gov/business-guidance/",
                },
              ],
            }),
          ],
        }),
      ]),
    ).toThrow(/duplicate canonical source URLs/);

    expect(() =>
      composeRulePacks([
        pack({
          rules: [
            buttonRule({ id: "test/source-a", officialSources: [source] }),
            buttonRule({
              id: "test/source-b",
              officialSources: [{ ...source, title: "Changed title" }],
            }),
          ],
        }),
      ]),
    ).toThrow(/official source identity fields must match within one RulePack/);

    expect(() =>
      composeRulePacks([
        pack({
          rules: [
            buttonRule({
              id: "test/source-review-a",
              officialSources: [source],
            }),
            buttonRule({
              id: "test/source-review-b",
              officialSources: [
                {
                  ...source,
                  jurisdictions: ["JP"],
                  reviewedAt: "2026-07-23",
                },
              ],
            }),
          ],
        }),
      ]),
    ).not.toThrow();

    expect(() =>
      composeRulePacks([
        pack({
          meta: { ...pack().meta, id: "test/source-pack-a" },
          rules: [buttonRule({ id: "test/source-pack-a-rule", officialSources: [source] })],
        }),
        pack({
          meta: { ...pack().meta, id: "test/source-pack-b" },
          rules: [
            buttonRule({
              id: "test/source-pack-b-rule",
              officialSources: [
                {
                  ...source,
                  title: "Different cross-pack title",
                },
              ],
            }),
          ],
        }),
      ]),
    ).not.toThrow();
  });

  it("rejects nested governance metadata with malformed shape or public strings", () => {
    const source = {
      id: "regulator/source",
      title: "Official source",
      publisher: "Regulator",
      url: "https://example.com/source",
      reviewedAt: "2026-07-22",
    };
    const symbolSource = { ...source };
    Object.defineProperty(symbolSource, Symbol("extra"), {
      value: true,
      enumerable: true,
    });
    class SourceFixture {
      id = source.id;
      title = source.title;
      publisher = source.publisher;
      url = source.url;
      reviewedAt = source.reviewedAt;
    }
    const symbolDeprecation = { since: "1.0.0", reason: "Deprecated." };
    Object.defineProperty(symbolDeprecation, Symbol("extra"), {
      value: true,
      enumerable: true,
    });
    class DeprecationFixture {
      since = "1.0.0";
      reason = "Deprecated.";
    }

    for (const officialSource of [
      { ...source, extra: true },
      symbolSource,
      new SourceFixture(),
      { ...source, url: "http://example.com/source" },
      { ...source, url: "https://user@example.com/source" },
      { ...source, url: " https://example.com/source" },
      { ...source, reviewedAt: "2026-02-30" },
      { ...source, title: "Official\u202esource" },
    ]) {
      expect(() =>
        composeRulePacks([
          pack({
            rules: [buttonRule({ officialSources: [officialSource as never] })],
          }),
        ]),
      ).toThrow(RulePackError);
    }

    for (const deprecation of [
      { since: "1.0.0", reason: "Deprecated.", extra: true },
      symbolDeprecation,
      new DeprecationFixture(),
      { since: "1.0.0", reason: " Deprecated." },
      { since: "1.0.0", reason: "Deprecated.\u202e" },
    ]) {
      expect(() =>
        composeRulePacks([
          pack({
            rules: [
              buttonRule({
                maturity: "deprecated",
                deprecation: deprecation as never,
              }),
            ],
          }),
        ]),
      ).toThrow(RulePackError);
    }
  });

  it("validates deprecation version bounds and replacements", () => {
    expect(() =>
      composeRulePacks([
        pack({
          meta: { ...pack().meta, version: "1.2.0" },
          rules: [
            buttonRule({
              id: "test/deprecated-future-since",
              maturity: "deprecated",
              deprecation: { since: "2.0.0", reason: "Future deprecation." },
            }),
          ],
        }),
      ]),
    ).toThrow(/since must be less than or equal/);

    expect(() =>
      composeRulePacks([
        pack({
          meta: { ...pack().meta, version: "1.2.0" },
          rules: [
            buttonRule({
              id: "test/deprecated-past-removal",
              maturity: "deprecated",
              deprecation: {
                since: "1.2.0",
                reason: "Past removal.",
                removalTarget: "1.2.0",
              },
            }),
          ],
        }),
      ]),
    ).toThrow(/removalTarget must be greater/);

    expect(() =>
      composeRulePacks([
        pack({
          rules: [
            buttonRule({
              id: "test/deprecated-rule",
              maturity: "deprecated",
              deprecation: {
                since: "1.0.0",
                reason: "Use the replacement rule.",
                replacementRuleId: "test/replacement-rule",
                removalTarget: "2.0.0",
              },
            }),
            buttonRule({ id: "test/replacement-rule" }),
          ],
        }),
      ]),
    ).not.toThrow();

    expect(() =>
      composeRulePacks([
        pack({
          rules: [
            buttonRule({
              id: "test/deprecated-rule",
              maturity: "deprecated",
              deprecation: {
                since: "1.0.0",
                reason: "Missing replacement target.",
                replacementRuleId: "test/missing-rule",
              },
            }),
          ],
        }),
      ]),
    ).toThrow(/target a rule in the same RulePack/);

    expect(() =>
      composeRulePacks([
        pack({
          rules: [
            buttonRule({
              id: "test/deprecated-rule",
              maturity: "deprecated",
              deprecation: {
                since: "1.0.0",
                reason: "Self replacement.",
                replacementRuleId: "test/deprecated-rule",
              },
            }),
          ],
        }),
      ]),
    ).toThrow(/different rule/);

    expect(() =>
      composeRulePacks([
        pack({
          rules: [
            buttonRule({
              id: "test/deprecated-source",
              maturity: "deprecated",
              deprecation: {
                since: "1.0.0",
                reason: "Use the replacement.",
                replacementRuleId: "test/deprecated-target",
              },
            }),
            buttonRule({
              id: "test/deprecated-target",
              maturity: "deprecated",
              deprecation: { since: "1.0.0", reason: "Also deprecated." },
            }),
          ],
        }),
      ]),
    ).toThrow(/must not target a deprecated rule/);
  });

  it("compares deprecation semver precedence without numeric precision loss", () => {
    expect(() =>
      composeRulePacks([
        pack({
          meta: { ...pack().meta, version: "9007199254740992.0.0" },
          rules: [
            buttonRule({
              maturity: "deprecated",
              deprecation: {
                since: "9007199254740993.0.0",
                reason: "Future unsafe integer version.",
              },
            }),
          ],
        }),
      ]),
    ).toThrow(/since must be less than or equal/);

    expect(() =>
      composeRulePacks([
        pack({
          meta: { ...pack().meta, version: "9007199254740992.0.0" },
          rules: [
            buttonRule({
              maturity: "deprecated",
              deprecation: {
                since: "9007199254740992.0.0",
                reason: "Large version deprecation.",
                removalTarget: "9007199254740993.0.0",
              },
            }),
          ],
        }),
      ]),
    ).not.toThrow();

    expect(() =>
      composeRulePacks([
        pack({
          meta: { ...pack().meta, version: "1.0.0-9007199254740992" },
          rules: [
            buttonRule({
              maturity: "deprecated",
              deprecation: {
                since: "1.0.0-9007199254740993",
                reason: "Future prerelease version.",
              },
            }),
          ],
        }),
      ]),
    ).toThrow(/since must be less than or equal/);

    expect(() =>
      composeRulePacks([
        pack({
          meta: { ...pack().meta, version: "1.0.0+build.1" },
          rules: [
            buttonRule({
              maturity: "deprecated",
              deprecation: {
                since: "1.0.0+build.2",
                reason: "Build metadata does not affect precedence.",
              },
            }),
          ],
        }),
      ]),
    ).not.toThrow();

    expect(() =>
      composeRulePacks([
        pack({
          meta: { ...pack().meta, version: "1.0.0-1.a" },
          rules: [
            buttonRule({
              maturity: "deprecated",
              deprecation: {
                since: "1.0.0-1",
                reason: "Numeric prerelease sorts before alphanumeric.",
                removalTarget: "1.0.0-1.a.1",
              },
            }),
          ],
        }),
      ]),
    ).not.toThrow();
  });

  it("accepts declared external taxonomy categories", () => {
    const rule = buttonRule({
      category: "purchase-guard/return-policy",
      id: "purchase-guard/missing-return-policy",
    });
    const composed = composeRulePacks([
      pack({
        meta: { ...pack().meta, id: "purchase-guard/rules-jp-commerce" },
        taxonomy: {
          categories: [
            {
              id: "purchase-guard/return-policy",
              title: "Return policy",
              description: "Return, refund, and exchange term signals.",
            },
          ],
        },
        rules: [rule],
      }),
    ]);

    expect(composed.rules[0]?.meta.category).toBe("purchase-guard/return-policy");
    expect(composed.taxonomy.categories.map((category) => category.id)).toEqual([
      "purchase-guard/return-policy",
    ]);
  });

  it("accepts npm scoped pack ids as taxonomy namespace owners", () => {
    const composed = composeRulePacks(
      [
        pack({
          meta: { ...pack().meta, id: "@purchase-guard/jp-commerce", status: "experimental" },
          taxonomy: {
            categories: [{ id: "purchase-guard/return-policy", title: "Return policy" }],
          },
          rules: [
            buttonRule({
              category: "purchase-guard/return-policy",
              id: "purchase-guard/missing-return-policy",
            }),
          ],
        }),
      ],
      { includeExperimental: true },
    );

    expect(composed.rules[0]?.meta.category).toBe("purchase-guard/return-policy");
  });

  it("rejects undeclared external rule categories", () => {
    expect(() =>
      composeRulePacks([
        pack({
          meta: { ...pack().meta, id: "purchase-guard/rules-jp-commerce" },
          rules: [
            buttonRule({
              category: "purchase-guard/return-policy",
              id: "purchase-guard/missing-return-policy",
            }),
          ],
        }),
      ]),
    ).toThrow(/external category must be declared/);
  });

  it("rejects duplicate and malformed external taxonomy categories", () => {
    const first = pack({
      meta: { ...pack().meta, id: "purchase-guard/first" },
      taxonomy: {
        categories: [{ id: "purchase-guard/return-policy", title: "Return policy" }],
      },
      rules: [buttonRule({ id: "purchase-guard/a", category: "purchase-guard/return-policy" })],
    });
    const second = pack({
      meta: { ...pack().meta, id: "purchase-guard/second" },
      taxonomy: {
        categories: [{ id: "purchase-guard/return-policy", title: "Return policy" }],
      },
      rules: [buttonRule({ id: "purchase-guard/b", category: "purchase-guard/return-policy" })],
    });

    expect(() => composeRulePacks([first, second], { includeExperimental: true })).toThrow(
      /Duplicate taxonomy category id/,
    );
    expect(() =>
      composeRulePacks([
        pack({
          meta: { ...pack().meta, id: "purchase-guard/rules-jp-commerce" },
          taxonomy: { categories: [{ id: "return-policy" as never, title: "Return policy" }] },
        }),
      ]),
    ).toThrow(/expected a namespaced id/);
    expect(() =>
      composeRulePacks([
        pack({
          meta: { ...pack().meta, id: "purchase-guard/rules-jp-commerce" },
          taxonomy: {
            categories: [{ id: "seller-guard/return-policy", title: "Return policy" }],
          },
        }),
      ]),
    ).toThrow(/expected namespace purchase-guard/);
    expect(() =>
      composeRulePacks([
        pack({
          taxonomy: { categories: [{ id: "hidden-cost", title: "Hidden cost" }] },
        }),
      ]),
    ).toThrow(/built-in category ids are reserved/);
  });

  it("rejects cross-pack category parents without depending on pack order", () => {
    const root = pack({
      meta: { ...pack().meta, id: "purchase-guard/root" },
      taxonomy: {
        categories: [{ id: "purchase-guard/root-risk", title: "Root risk" }],
      },
      rules: [buttonRule({ id: "purchase-guard/root-rule", category: "purchase-guard/root-risk" })],
    });
    const child = pack({
      meta: { ...pack().meta, id: "purchase-guard/child" },
      taxonomy: {
        categories: [
          {
            id: "purchase-guard/return-policy",
            title: "Return policy",
            parentId: "purchase-guard/root-risk",
          },
        ],
      },
      rules: [
        buttonRule({
          id: "purchase-guard/child-rule",
          category: "purchase-guard/return-policy",
        }),
      ],
    });

    expect(() => composeRulePacks([root, child])).toThrow(/same rule pack/);
    expect(() => composeRulePacks([child, root])).toThrow(/same rule pack/);
  });

  it("accepts same-pack category parents without depending on declaration order", () => {
    const composed = composeRulePacks([
      pack({
        meta: { ...pack().meta, id: "purchase-guard/rules-jp-commerce" },
        taxonomy: {
          categories: [
            {
              id: "purchase-guard/return-policy",
              title: "Return policy",
              parentId: "purchase-guard/buyer-rights",
            },
            {
              id: "purchase-guard/buyer-rights",
              title: "Buyer rights",
            },
          ],
        },
        rules: [
          buttonRule({
            id: "purchase-guard/return-policy-rule",
            category: "purchase-guard/return-policy",
          }),
        ],
      }),
    ]);

    expect(composed.taxonomy.categories.map((category) => category.id)).toEqual([
      "purchase-guard/return-policy",
      "purchase-guard/buyer-rights",
    ]);
  });

  it("accepts built-in category parents", () => {
    const composed = composeRulePacks([
      pack({
        meta: { ...pack().meta, id: "purchase-guard/rules-jp-commerce" },
        taxonomy: {
          categories: [
            {
              id: "purchase-guard/purchase-pressure",
              title: "Purchase pressure",
              parentId: "scarcity",
            },
          ],
        },
        rules: [
          buttonRule({
            id: "purchase-guard/purchase-pressure-rule",
            category: "purchase-guard/purchase-pressure",
          }),
        ],
      }),
    ]);

    expect(composed.taxonomy.categories[0]?.parentId).toBe("scarcity");
  });

  it("rejects category parent cycles", () => {
    expect(() =>
      composeRulePacks([
        pack({
          meta: { ...pack().meta, id: "purchase-guard/rules-jp-commerce" },
          taxonomy: {
            categories: [
              {
                id: "purchase-guard/a",
                title: "A",
                parentId: "purchase-guard/b",
              },
              {
                id: "purchase-guard/b",
                title: "B",
                parentId: "purchase-guard/a",
              },
            ],
          },
          rules: [buttonRule({ id: "purchase-guard/a-rule", category: "purchase-guard/a" })],
        }),
      ]),
    ).toThrow(/cyclic taxonomy category parents/);
  });

  it("ignores excluded experimental taxonomy for global collisions", () => {
    const experimental = pack({
      meta: { ...pack().meta, id: "purchase-guard/experimental", status: "experimental" },
      taxonomy: {
        categories: [{ id: "purchase-guard/return-policy", title: "Return policy" }],
      },
      rules: [
        buttonRule({
          id: "purchase-guard/experimental-rule",
          category: "purchase-guard/return-policy",
        }),
      ],
    });
    const stable = pack({
      meta: { ...pack().meta, id: "purchase-guard/stable" },
      taxonomy: {
        categories: [{ id: "purchase-guard/return-policy", title: "Return policy" }],
      },
      rules: [
        buttonRule({
          id: "purchase-guard/stable-rule",
          category: "purchase-guard/return-policy",
        }),
      ],
    });

    expect(composeRulePacks([experimental, stable]).rules.map((rule) => rule.meta.id)).toEqual([
      "purchase-guard/stable-rule",
    ]);
    expect(() => composeRulePacks([experimental, stable], { includeExperimental: true })).toThrow(
      /Duplicate taxonomy category id/,
    );
  });

  it("accepts declared external page contexts and rejects undeclared ones", () => {
    const rule = buttonRule({
      id: "purchase-guard/form-risk",
      appliesTo: ["purchase-guard/checkout-form"],
    });

    expect(() =>
      composeRulePacks([
        pack({
          meta: { ...pack().meta, id: "purchase-guard/rules-jp-commerce" },
          taxonomy: {
            pageContexts: [{ id: "purchase-guard/checkout-form", title: "Checkout form" }],
          },
          rules: [rule],
        }),
      ]),
    ).not.toThrow();

    expect(() =>
      composeRulePacks([
        pack({
          meta: { ...pack().meta, id: "purchase-guard/rules-jp-commerce" },
          rules: [rule],
        }),
      ]),
    ).toThrow(/external page context must be declared/);
  });

  it("accepts RFC 5646 locale dictionary keys", () => {
    const composed = composeRulePacks([
      pack({
        dictionary: {
          "x-private": {
            cta: [/buy/],
          },
          "ja-JP": {
            returnPolicy: [/返品/],
          },
          "en-u-ca-gregory": {
            renewal: [/renewal/],
          },
          "en-a-foo-x-a-bar": {
            privateUse: [/private/],
          },
        },
      }),
    ]);

    expect(composed.dictionary["x-private"]?.cta).toHaveLength(1);
    expect(composed.dictionary["ja-JP"]?.returnPolicy).toHaveLength(1);
    expect(composed.dictionary["en-u-ca-gregory"]?.renewal).toHaveLength(1);
    expect(composed.dictionary["en-a-foo-x-a-bar"]?.privateUse).toHaveLength(1);
  });

  it("rejects malformed RFC 5646 locale dictionary keys", () => {
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
      expect(() =>
        composeRulePacks([
          pack({
            dictionary: {
              [locale]: {
                cta: [/buy/],
              },
            },
          }),
        ]),
      ).toThrow(RulePackError);
    }
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
    expect(composed.taxonomy).toEqual({ categories: [], pageContexts: [] });
    expect(composed.rules.map((rule) => rule.meta.id)).toEqual(["test/button"]);
    expect(composed.rules[0]?.meta.tags).toEqual([]);
    expect(composed.dictionary.en?.cta?.[0]?.test("Buy now")).toBe(true);
    expect(composed.rules[0]?.evaluate).toBe(originalEvaluate);
  });

  it("snapshots and freezes nested governance metadata", () => {
    const requiredCapabilities = ["structure", "text"];
    const optionalCapabilities = ["computed-style"];
    const evidenceRequirements = ["presence", "text-match"];
    const jurisdictions = ["US"];
    const sourceJurisdictions = ["EU"];
    const officialSource = {
      id: "regulator/checkout-guidance",
      title: "Checkout guidance",
      publisher: "Example regulator",
      url: "https://example.test/checkout-guidance",
      jurisdictions: sourceJurisdictions,
      reviewedAt: "2026-07-22",
    };
    const knownLimitations = ["Static analysis only."];
    const deprecation = {
      since: "1.0.0",
      reason: "Replaced by a more precise rule.",
      removalTarget: "2.0.0",
    };
    const composed = composeRulePacks([
      pack({
        rules: [
          buttonRule({
            id: "test/governance",
            requiredCapabilities: requiredCapabilities as never,
            optionalCapabilities: optionalCapabilities as never,
            evidenceRequirements: evidenceRequirements as never,
            jurisdictions: jurisdictions as never,
            officialSources: [officialSource] as never,
            knownLimitations: knownLimitations as never,
          }),
          buttonRule({
            id: "test/deprecated",
            maturity: "deprecated",
            deprecation,
          }),
        ],
      }),
    ]);

    requiredCapabilities[0] = "network";
    optionalCapabilities.push("viewport");
    evidenceRequirements[0] = "absence";
    jurisdictions[0] = "JP";
    sourceJurisdictions[0] = "GB";
    officialSource.title = "Changed source";
    knownLimitations[0] = "Changed limitation.";
    deprecation.reason = "Changed reason.";

    const governanceMeta = composed.rules.find((rule) => rule.meta.id === "test/governance")?.meta;
    const deprecatedMeta = composed.rules.find((rule) => rule.meta.id === "test/deprecated")?.meta;

    expect(governanceMeta?.requiredCapabilities).toEqual(["structure", "text"]);
    expect(governanceMeta?.optionalCapabilities).toEqual(["computed-style"]);
    expect(governanceMeta?.evidenceRequirements).toEqual(["presence", "text-match"]);
    expect(governanceMeta?.jurisdictions).toEqual(["US"]);
    expect(governanceMeta?.officialSources?.[0]).toMatchObject({
      id: "regulator/checkout-guidance",
      title: "Checkout guidance",
      jurisdictions: ["EU"],
    });
    expect(governanceMeta?.knownLimitations).toEqual(["Static analysis only."]);
    expect(deprecatedMeta?.deprecation?.reason).toBe("Replaced by a more precise rule.");

    expect(Object.isFrozen(governanceMeta?.requiredCapabilities)).toBe(true);
    expect(Object.isFrozen(governanceMeta?.optionalCapabilities)).toBe(true);
    expect(Object.isFrozen(governanceMeta?.evidenceRequirements)).toBe(true);
    expect(Object.isFrozen(governanceMeta?.jurisdictions)).toBe(true);
    expect(Object.isFrozen(governanceMeta?.officialSources)).toBe(true);
    expect(Object.isFrozen(governanceMeta?.officialSources?.[0])).toBe(true);
    expect(Object.isFrozen(governanceMeta?.officialSources?.[0]?.jurisdictions)).toBe(true);
    expect(Object.isFrozen(governanceMeta?.knownLimitations)).toBe(true);
    expect(Object.isFrozen(deprecatedMeta?.deprecation)).toBe(true);
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
    expect(scanner.taxonomy).toEqual({ categories: [], pageContexts: [] });
    expect(Object.isFrozen(scanner.taxonomy)).toBe(true);
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
