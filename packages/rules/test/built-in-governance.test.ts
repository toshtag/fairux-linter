import { describe, expect, it } from "vitest";
import generatedRuleCatalog from "../../../docs/generated/rule-catalog.json" with { type: "json" };
import { isBuiltinJurisdictionId, isSemver } from "../../core/src/index.js";
import reviewRecordsFixture from "../reviews/built-in-rule-reviews.json" with { type: "json" };
import sourceCatalogFixture from "../reviews/official-sources.json" with { type: "json" };
import {
  renderReviewedGovernanceArtifacts,
  reviewedGovernance,
} from "../scripts/generate-reviewed-governance.mjs";
import {
  renderRuleCatalogArtifacts,
  runtimeGovernanceProjectionFromPack,
  validateRuntimeGovernanceParity,
} from "../scripts/generate-rule-catalog.mjs";
import { collectRuntimeRuleMetadata } from "../scripts/review-validation.mjs";
import { fairuxBuiltinRulePack } from "../src/index.js";

type MutableFixture = Record<string, unknown>;
type RuleMetaContract = {
  readonly id: string;
  readonly officialSources?: readonly {
    readonly id: string;
    readonly jurisdictions?: readonly string[];
  }[];
  readonly knownLimitations?: readonly string[];
  readonly requiredCapabilities?: readonly string[];
  readonly optionalCapabilities?: readonly string[];
  readonly evidenceRequirements?: readonly string[];
  readonly jurisdictions?: readonly string[];
  readonly tags?: readonly string[];
};

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function reviewRuleIds() {
  return reviewRecordsFixture.rules.map((rule) => rule.ruleId);
}

function catalogRule(ruleId: string): MutableFixture {
  const rule = (generatedRuleCatalog.rules as MutableFixture[]).find(
    (entry) => (entry.identity as MutableFixture).id === ruleId,
  );
  if (rule === undefined) throw new Error(`missing catalog rule ${ruleId}`);
  return rule;
}

function reviewSourcesById(): ReadonlyMap<string, unknown> {
  return new Map(sourceCatalogFixture.sources.map((source) => [source.id, source]));
}

function mutablePackWithRuleMeta(
  ruleId: string,
  mutate: (meta: Record<string, unknown>) => void,
): MutableFixture {
  return {
    meta: fairuxBuiltinRulePack.meta,
    rules: fairuxBuiltinRulePack.rules.map((rule) => {
      if (rule.meta.id !== ruleId) return rule;
      const meta = clone(rule.meta) as unknown as Record<string, unknown>;
      mutate(meta);
      return { ...rule, meta };
    }),
  };
}

function expectFrozenArray(value: readonly unknown[] | undefined): void {
  if (value !== undefined) expect(Object.isFrozen(value)).toBe(true);
}

describe("built-in runtime governance", () => {
  it("keeps the actual runtime RulePack in parity with the 13 reviewed records", () => {
    expect([...fairuxBuiltinRulePack.rules.map((rule) => rule.meta.id)].sort()).toEqual(
      [...reviewRuleIds()].sort(),
    );
    expect(collectRuntimeRuleMetadata(fairuxBuiltinRulePack.rules)).toEqual(
      [...reviewRecordsFixture.rules]
        .map((rule) => ({
          id: rule.ruleId,
          version: rule.ruleVersion,
          maturity: rule.maturity,
          experimental: rule.maturity === "experimental",
          defaultEnabled: rule.maturity !== "experimental",
        }))
        .sort((left, right) => left.id.localeCompare(right.id)),
    );
  });

  it("keeps actual runtime governance in exact parity with the review-derived projection", () => {
    const expectedProjection = reviewedGovernance(reviewRecordsFixture, reviewSourcesById());
    const actualProjection = runtimeGovernanceProjectionFromPack(fairuxBuiltinRulePack);
    expect(Object.keys(actualProjection)).toHaveLength(13);
    expect(actualProjection).toEqual(expectedProjection);
  });

  it.each([
    [
      "different rule jurisdictions",
      "consent/checked-checkbox",
      (meta: Record<string, unknown>) => {
        const other = fairuxBuiltinRulePack.rules.find(
          (rule) => rule.meta.id === "hidden-cost/price-near-checkout-without-fee-disclosure",
        );
        meta.jurisdictions = [...(other?.meta.jurisdictions ?? [])];
      },
      /checked-checkbox\.jurisdictions/,
    ],
    [
      "different rule officialSources",
      "consent/checked-checkbox",
      (meta: Record<string, unknown>) => {
        const other = fairuxBuiltinRulePack.rules.find(
          (rule) => rule.meta.id === "obstruction/modal-close-visibility",
        );
        meta.officialSources = clone(other?.meta.officialSources ?? []);
      },
      /checked-checkbox\.officialSources/,
    ],
    [
      "different rule knownLimitations",
      "consent/checked-checkbox",
      (meta: Record<string, unknown>) => {
        const other = fairuxBuiltinRulePack.rules.find(
          (rule) => rule.meta.id === "scarcity/countdown-timer",
        );
        meta.knownLimitations = [...(other?.meta.knownLimitations ?? [])];
      },
      /checked-checkbox\.knownLimitations/,
    ],
    [
      "source reviewedAt drift",
      "consent/checked-checkbox",
      (meta: Record<string, unknown>) => {
        const sources = clone(meta.officialSources) as Record<string, unknown>[];
        sources[0] = { ...sources[0], reviewedAt: "2026-01-02" };
        meta.officialSources = sources;
      },
      /checked-checkbox\.officialSources/,
    ],
    [
      "source jurisdictions drift",
      "consent/checked-checkbox",
      (meta: Record<string, unknown>) => {
        const sources = clone(meta.officialSources) as Record<string, unknown>[];
        sources[0] = { ...sources[0], jurisdictions: ["US"] };
        meta.officialSources = sources;
      },
      /checked-checkbox\.officialSources/,
    ],
    [
      "official source order drift",
      "consent/checked-checkbox",
      (meta: Record<string, unknown>) => {
        meta.officialSources = [...(clone(meta.officialSources) as unknown[])].reverse();
      },
      /checked-checkbox\.officialSources/,
    ],
  ])("fails catalog rendering before artifacts on %s", (_label, ruleId, mutate, expectedError) => {
    const expectedProjection = reviewedGovernance(reviewRecordsFixture, reviewSourcesById());
    const rulePack = mutablePackWithRuleMeta(ruleId, mutate);

    const parity = validateRuntimeGovernanceParity(expectedProjection, rulePack);
    expect(parity.ok).toBe(false);
    expect(parity.errors.join("\n")).toMatch(expectedError);
    expect(() =>
      renderRuleCatalogArtifacts({
        rootDir: ".",
        sourceCatalog: sourceCatalogFixture,
        reviewRecords: reviewRecordsFixture,
        rulePack,
        runtimeRules: collectRuntimeRuleMetadata(fairuxBuiltinRulePack.rules),
        isBuiltinJurisdictionId,
        isSemver,
      }),
    ).toThrow(/Runtime governance parity validation failed/);
  });

  it("freezes nested governance arrays and source objects on actual built-in metadata", () => {
    expect(Object.isFrozen(fairuxBuiltinRulePack)).toBe(true);
    expect(Object.isFrozen(fairuxBuiltinRulePack.meta)).toBe(true);
    expect(Object.isFrozen(fairuxBuiltinRulePack.rules)).toBe(true);

    for (const rule of fairuxBuiltinRulePack.rules) {
      const meta = rule.meta as RuleMetaContract;
      expect(Object.isFrozen(rule)).toBe(true);
      expect(Object.isFrozen(rule.meta)).toBe(true);
      expectFrozenArray(meta.tags);
      expectFrozenArray(meta.requiredCapabilities);
      expectFrozenArray(meta.optionalCapabilities);
      expectFrozenArray(meta.evidenceRequirements);
      expectFrozenArray(meta.jurisdictions);
      expectFrozenArray(meta.knownLimitations);
      expectFrozenArray(meta.officialSources);
      for (const source of meta.officialSources ?? []) {
        expect(Object.isFrozen(source)).toBe(true);
        expectFrozenArray(source.jurisdictions);
      }
    }
  });

  it("keeps generated catalog counts and pack identity sourced from the actual runtime pack", () => {
    expect(generatedRuleCatalog.pack).toEqual({
      id: fairuxBuiltinRulePack.meta.id,
      version: fairuxBuiltinRulePack.meta.version,
    });
    expect(generatedRuleCatalog.counts).toMatchObject({
      ruleCount: 13,
      stableRuleCount: 11,
      experimentalRuleCount: 2,
      runtimeSourceMappingCount: 30,
      fullSourceMappingCount: 36,
    });
    for (const rule of fairuxBuiltinRulePack.rules) {
      const catalog = catalogRule(rule.meta.id);
      expect(catalog.identity).toMatchObject({
        id: rule.meta.id,
        title: rule.meta.title,
        category: rule.meta.category,
        version: rule.meta.version,
      });
      expect(catalog.execution).toMatchObject({
        defaultSeverity: rule.meta.defaultSeverity,
        defaultConfidence: rule.meta.defaultConfidence,
        defaultEnabled: rule.meta.defaultEnabled,
        experimental: rule.meta.experimental === true,
      });
    }
  });

  it("keeps non-current sources out of runtime governance and inside full catalog provenance", () => {
    const runtimeSourceIds = fairuxBuiltinRulePack.rules.flatMap((rule) =>
      (rule.meta.officialSources ?? []).map((source) => source.id),
    );
    expect(runtimeSourceIds).toHaveLength(30);
    expect(runtimeSourceIds).not.toContain("us/ftc-negative-option-2024-vacated-final-rule");
    expect(runtimeSourceIds).not.toContain("us/ftc-negative-option-2026-anprm");

    const fullSourceIds = (generatedRuleCatalog.rules as MutableFixture[]).flatMap((rule) =>
      ((rule.officialSourceReviewProvenance as MutableFixture[]) ?? []).map(
        (entry) => (entry.source as MutableFixture | undefined)?.id,
      ),
    );
    expect(fullSourceIds).toHaveLength(36);
    expect(fullSourceIds).toContain("us/ftc-negative-option-2024-vacated-final-rule");
    expect(fullSourceIds).toContain("us/ftc-negative-option-2026-anprm");
  });

  it("renders nothing when invalid review input fails validation", () => {
    const invalidRecords = clone(reviewRecordsFixture) as MutableFixture;
    const firstRule = (invalidRecords.rules as MutableFixture[])[0];
    if (firstRule === undefined) throw new Error("missing review fixture");
    firstRule.ruleJurisdictions = ["UK"];

    const input = {
      rootDir: ".",
      sourceCatalog: sourceCatalogFixture,
      reviewRecords: invalidRecords,
      runtimeRules: collectRuntimeRuleMetadata(fairuxBuiltinRulePack.rules),
      isBuiltinJurisdictionId,
      isSemver,
    };
    expect(() => renderReviewedGovernanceArtifacts(input)).toThrow(/validation failed/i);
    expect(() => renderRuleCatalogArtifacts(input)).toThrow(/validation failed/i);
  });

  it("keeps the generated maintainer catalog reviewable", () => {
    const rendered = renderRuleCatalogArtifacts({
      rootDir: ".",
      sourceCatalog: sourceCatalogFixture,
      reviewRecords: reviewRecordsFixture,
      runtimeRules: collectRuntimeRuleMetadata(fairuxBuiltinRulePack.rules),
      isBuiltinJurisdictionId,
      isSemver,
    });
    const markdown = rendered.artifacts.find((artifact) =>
      artifact.path.endsWith("docs/rules.md"),
    )?.contents;
    expect(markdown).toBeDefined();
    if (markdown === undefined) throw new Error("missing rendered docs/rules.md artifact");
    expect(markdown.match(/^- Jurisdictions:/gm)).toHaveLength(13);
    expect(markdown.match(/https:\/\/www\./g)?.length ?? 0).toBeGreaterThan(0);
    expect(markdown).toContain("- Tags:");
    expect(markdown).toContain("- Applies to:");
    expect(markdown).toContain("- Applies-to minimum confidence:");
    expect(markdown).toContain("- Reviewed at:");
    expect(markdown).toContain("- Source locator:");
    expect(markdown).not.toMatch(/\.\./);
  });
});
