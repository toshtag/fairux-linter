import { composeRulePacks, RulePackError } from "@fairux/sdk";
import { invalidRulePack as emptyRequiredPack } from "../sdk-custom-rule-pack/invalid/governance-empty-required.mjs";
import { invalidRulePack as invalidDeprecationPack } from "../sdk-custom-rule-pack/invalid/governance-invalid-deprecation.mjs";
import { invalidRulePack as invalidSourcePack } from "../sdk-custom-rule-pack/invalid/governance-invalid-source.mjs";
import { rulePack as validGovernancePack } from "../sdk-custom-rule-pack/valid/governance-pack.mjs";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertFrozen(value, message) {
  assert(Object.isFrozen(value), message);
}

function assertRulePackError(fn, message) {
  try {
    fn();
  } catch (error) {
    assert(error instanceof RulePackError, message);
    return 1;
  }
  throw new Error(message);
}

const composed = composeRulePacks([validGovernancePack], { includeExperimental: true });
const governanceRule = composed.rules.find((rule) => rule.meta.id === "example/governance-rule");
const deprecatedRule = composed.rules.find(
  (rule) => rule.meta.id === "example/deprecated-governance-rule",
);

assert(governanceRule, "expected governed rule in composed pack");
assert(deprecatedRule, "expected deprecated governed rule in composed pack");
assert(
  governanceRule.meta.optionalCapabilities?.join(",") === "computed-style",
  "expected optional capabilities to be preserved",
);
assert(governanceRule.meta.jurisdictions?.join(",") === "US", "expected jurisdictions");
assert(
  governanceRule.meta.officialSources?.[0]?.id === "regulator/checkout-guidance",
  "expected official source identity",
);
assert(
  governanceRule.meta.officialSources?.[0]?.jurisdictions?.join(",") === "US",
  "expected official source jurisdictions",
);
assert(
  governanceRule.meta.knownLimitations?.[0] === "Fixture analysis uses static markup only.",
  "expected known limitations",
);
assert(
  deprecatedRule.meta.deprecation?.replacementRuleId === "example/governance-rule",
  "expected deprecation metadata",
);

assertFrozen(governanceRule.meta.requiredCapabilities, "required capabilities not frozen");
assertFrozen(governanceRule.meta.optionalCapabilities, "optional capabilities not frozen");
assertFrozen(governanceRule.meta.evidenceRequirements, "evidence requirements not frozen");
assertFrozen(governanceRule.meta.jurisdictions, "jurisdictions not frozen");
assertFrozen(governanceRule.meta.officialSources, "official sources not frozen");
assertFrozen(governanceRule.meta.officialSources[0], "official source not frozen");
assertFrozen(
  governanceRule.meta.officialSources[0].jurisdictions,
  "official source jurisdictions not frozen",
);
assertFrozen(governanceRule.meta.knownLimitations, "known limitations not frozen");
assertFrozen(deprecatedRule.meta.deprecation, "deprecation metadata not frozen");

validGovernancePack.rules[0].meta.optionalCapabilities.push("network");
validGovernancePack.rules[0].meta.jurisdictions[0] = "JP";
validGovernancePack.rules[0].meta.officialSources[0].title = "Changed source title";
validGovernancePack.rules[0].meta.officialSources[0].jurisdictions.push("EU");
validGovernancePack.rules[0].meta.knownLimitations[0] = "Changed limitation.";
validGovernancePack.rules[1].meta.deprecation.reason = "Changed reason.";

assert(
  governanceRule.meta.optionalCapabilities?.join(",") === "computed-style",
  "composed optional capabilities changed after source mutation",
);
assert(
  governanceRule.meta.jurisdictions?.join(",") === "US",
  "composed jurisdictions changed after source mutation",
);
assert(
  governanceRule.meta.officialSources?.[0]?.title === "Checkout guidance",
  "composed official source changed after source mutation",
);
assert(
  governanceRule.meta.officialSources?.[0]?.jurisdictions?.join(",") === "US",
  "composed source jurisdictions changed after source mutation",
);
assert(
  governanceRule.meta.knownLimitations?.[0] === "Fixture analysis uses static markup only.",
  "composed known limitations changed after source mutation",
);
assert(
  deprecatedRule.meta.deprecation?.reason ===
    "The main governance fixture rule is the maintained contract example.",
  "composed deprecation changed after source mutation",
);

const invalidPacksRejected =
  assertRulePackError(
    () => composeRulePacks([emptyRequiredPack], { includeExperimental: true }),
    "empty required capabilities should be rejected",
  ) +
  assertRulePackError(
    () => composeRulePacks([invalidSourcePack], { includeExperimental: true }),
    "invalid official source should be rejected",
  ) +
  assertRulePackError(
    () => composeRulePacks([invalidDeprecationPack], { includeExperimental: true }),
    "invalid deprecation should be rejected",
  );

console.log(
  JSON.stringify({
    ok: true,
    fullMetadata: true,
    frozen: true,
    mutationIsolated: true,
    invalidPacksRejected,
  }),
);
