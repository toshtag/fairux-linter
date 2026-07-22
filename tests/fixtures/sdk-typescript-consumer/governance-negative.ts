import type { RulePack } from "@fairux/sdk";

const baseRulePackMeta = {
  id: "negative/governance-pack",
  version: "0.1.0",
  engineApiVersion: "1",
  title: "Negative governance pack",
  status: "stable",
} satisfies RulePack["meta"];

const baseRuleMeta = {
  id: "negative/governance-rule",
  title: "Negative governance rule",
  category: "obstruction",
  defaultSeverity: "low",
  defaultConfidence: "low",
  defaultEnabled: true,
  tags: [],
  version: "1.0.0",
  maturity: "stable",
  requiredCapabilities: ["structure"],
  evidenceRequirements: ["presence"],
} satisfies RulePack["rules"][number]["meta"];

export const emptyRequiredCapabilitiesPack: RulePack = {
  meta: baseRulePackMeta,
  rules: [
    {
      meta: {
        ...baseRuleMeta,
        // @ts-expect-error requiredCapabilities must be non-empty.
        requiredCapabilities: [],
      },
      evaluate() {
        return [];
      },
    },
  ],
};

export const emptyEvidenceRequirementsPack: RulePack = {
  meta: baseRulePackMeta,
  rules: [
    {
      meta: {
        ...baseRuleMeta,
        // @ts-expect-error evidenceRequirements must be non-empty.
        evidenceRequirements: [],
      },
      evaluate() {
        return [];
      },
    },
  ],
};

export const emptyOptionalCapabilitiesPack: RulePack = {
  meta: baseRulePackMeta,
  rules: [
    {
      meta: {
        ...baseRuleMeta,
        // @ts-expect-error optionalCapabilities must be non-empty when present.
        optionalCapabilities: [],
      },
      evaluate() {
        return [];
      },
    },
  ],
};

export const emptyJurisdictionsPack: RulePack = {
  meta: baseRulePackMeta,
  rules: [
    {
      meta: {
        ...baseRuleMeta,
        // @ts-expect-error jurisdictions must be non-empty when present.
        jurisdictions: [],
      },
      evaluate() {
        return [];
      },
    },
  ],
};

export const emptyOfficialSourcesPack: RulePack = {
  meta: baseRulePackMeta,
  rules: [
    {
      meta: {
        ...baseRuleMeta,
        // @ts-expect-error officialSources must be non-empty when present.
        officialSources: [],
      },
      evaluate() {
        return [];
      },
    },
  ],
};

export const emptyKnownLimitationsPack: RulePack = {
  meta: baseRulePackMeta,
  rules: [
    {
      meta: {
        ...baseRuleMeta,
        // @ts-expect-error knownLimitations must be non-empty when present.
        knownLimitations: [],
      },
      evaluate() {
        return [];
      },
    },
  ],
};

export const emptySourceJurisdictionsPack: RulePack = {
  meta: baseRulePackMeta,
  rules: [
    {
      meta: {
        ...baseRuleMeta,
        officialSources: [
          {
            id: "regulator/source",
            title: "Source",
            publisher: "Regulator",
            url: "https://example.com/source",
            reviewedAt: "2026-07-22",
            // @ts-expect-error source jurisdictions must be non-empty when present.
            jurisdictions: [],
          },
        ],
      },
      evaluate() {
        return [];
      },
    },
  ],
};
