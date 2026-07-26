import { describe, expect, it } from "vitest";
import generatedRuleCatalog from "../../../docs/generated/rule-catalog.json" with { type: "json" };
import { isBuiltinJurisdictionId, isSemver } from "../../core/src/index.js";
import reviewRecordsFixture from "../reviews/built-in-rule-reviews.json" with { type: "json" };
import sourceCatalogFixture from "../reviews/official-sources.json" with { type: "json" };
import { renderReviewedGovernanceArtifacts } from "../scripts/generate-reviewed-governance.mjs";
import { renderRuleCatalogArtifacts } from "../scripts/generate-rule-catalog.mjs";
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
});
