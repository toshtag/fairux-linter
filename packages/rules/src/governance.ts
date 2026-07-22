import type { RuleMeta } from "@fairux/core";

type RuleGovernanceFields = Pick<
  RuleMeta,
  "maturity" | "requiredCapabilities" | "optionalCapabilities" | "evidenceRequirements"
>;

export const attributeStateGovernance = Object.freeze({
  maturity: "stable",
  requiredCapabilities: ["structure", "attributes"],
  evidenceRequirements: ["presence", "attribute-state"],
} satisfies RuleGovernanceFields);

export const staticTextPresenceGovernance = Object.freeze({
  maturity: "stable",
  requiredCapabilities: ["structure", "text"],
  evidenceRequirements: ["presence", "text-match"],
} satisfies RuleGovernanceFields);

export const staticTextAbsenceGovernance = Object.freeze({
  maturity: "stable",
  requiredCapabilities: ["structure", "text"],
  evidenceRequirements: ["presence", "absence", "text-match"],
} satisfies RuleGovernanceFields);

export const staticComparisonGovernance = Object.freeze({
  maturity: "stable",
  requiredCapabilities: ["structure", "text"],
  evidenceRequirements: ["comparison", "text-match"],
} satisfies RuleGovernanceFields);

export const modalStructureGovernance = Object.freeze({
  maturity: "stable",
  requiredCapabilities: ["structure", "text", "attributes"],
  evidenceRequirements: ["presence", "absence", "text-match"],
} satisfies RuleGovernanceFields);

export const visualImbalanceExperimentalGovernance = Object.freeze({
  maturity: "experimental",
  requiredCapabilities: ["structure", "text", "style-hints"],
  optionalCapabilities: ["computed-style"],
  evidenceRequirements: ["comparison", "text-match"],
} satisfies RuleGovernanceFields);

export const modalVisibilityExperimentalGovernance = Object.freeze({
  maturity: "experimental",
  requiredCapabilities: ["structure", "text", "attributes", "style-hints"],
  optionalCapabilities: ["computed-style", "viewport"],
  evidenceRequirements: ["presence", "attribute-state"],
} satisfies RuleGovernanceFields);
