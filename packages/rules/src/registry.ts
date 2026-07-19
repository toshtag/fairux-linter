import type { Rule, RulePack } from "@fairux/core";
import { missingCancellationLink } from "./cancellation/missing-cancellation-link.js";
import { acceptRejectVisualImbalance } from "./consent/accept-reject-visual-imbalance.js";
import { bundledConsent } from "./consent/bundled-consent.js";
import { checkedCheckbox } from "./consent/checked-checkbox.js";
import { missingRejectOption } from "./consent/missing-reject-option.js";
import { dictionary } from "./dictionary.js";
import { priceNearCheckoutWithoutFeeDisclosure } from "./hidden-cost/price-near-checkout-without-fee-disclosure.js";
import { confirmshaming } from "./obstruction/confirmshaming.js";
import { modalCloseVisibility } from "./obstruction/modal-close-visibility.js";
import { modalWithoutCloseAction } from "./obstruction/modal-without-close-action.js";
import { countdownTimer } from "./scarcity/countdown-timer.js";
import { scarcityPhrase } from "./scarcity/scarcity-phrase.js";
import { snapshotDictionary, snapshotRule, snapshotRulePackMeta } from "./snapshot.js";
import { ctaWithoutCancellationContext } from "./subscription/cta-without-cancellation-context.js";
import { freeTrialWithoutRenewalDisclosure } from "./subscription/free-trial-without-renewal-disclosure.js";

const checkedCheckboxRule = snapshotRule(checkedCheckbox);
const missingRejectOptionRule = snapshotRule(missingRejectOption);
const bundledConsentRule = snapshotRule(bundledConsent);
const freeTrialWithoutRenewalDisclosureRule = snapshotRule(freeTrialWithoutRenewalDisclosure);
const ctaWithoutCancellationContextRule = snapshotRule(ctaWithoutCancellationContext);
const missingCancellationLinkRule = snapshotRule(missingCancellationLink);
const scarcityPhraseRule = snapshotRule(scarcityPhrase);
const countdownTimerRule = snapshotRule(countdownTimer);
const priceNearCheckoutWithoutFeeDisclosureRule = snapshotRule(
  priceNearCheckoutWithoutFeeDisclosure,
);
const modalWithoutCloseActionRule = snapshotRule(modalWithoutCloseAction);
const confirmshamingRule = snapshotRule(confirmshaming);
const acceptRejectVisualImbalanceRule = snapshotRule(acceptRejectVisualImbalance);
const modalCloseVisibilityRule = snapshotRule(modalCloseVisibility);

export const consentRules = Object.freeze([
  checkedCheckboxRule,
  missingRejectOptionRule,
  bundledConsentRule,
] satisfies readonly Rule[]);

export const subscriptionRules = Object.freeze([
  freeTrialWithoutRenewalDisclosureRule,
  ctaWithoutCancellationContextRule,
] satisfies readonly Rule[]);

export const cancellationRules = Object.freeze([
  missingCancellationLinkRule,
] satisfies readonly Rule[]);

export const scarcityRules = Object.freeze([
  scarcityPhraseRule,
  countdownTimerRule,
] satisfies readonly Rule[]);

export const hiddenCostRules = Object.freeze([
  priceNearCheckoutWithoutFeeDisclosureRule,
] satisfies readonly Rule[]);

export const obstructionRules = Object.freeze([
  modalWithoutCloseActionRule,
  confirmshamingRule,
] satisfies readonly Rule[]);

/** Experimental rules: disabled by default; run only when explicitly enabled. */
export const experimentalRules = Object.freeze([
  acceptRejectVisualImbalanceRule,
  modalCloseVisibilityRule,
] satisfies readonly Rule[]);

/** Every rule FairUX ships (enabled + experimental). scan() filters experimental ones out by default. */
export const allRules = Object.freeze([
  ...consentRules,
  ...subscriptionRules,
  ...cancellationRules,
  ...scarcityRules,
  ...hiddenCostRules,
  ...obstructionRules,
  ...experimentalRules,
]) satisfies readonly Rule[];

const fairuxBuiltinRulePackMeta = snapshotRulePackMeta({
  id: "@fairux/builtin",
  version: "0.1.0",
  engineApiVersion: "1",
  title: "FairUX built-in rules",
  description: "Deterministic FairUX dark-pattern rule pack.",
  status: "stable",
});

const immutableBuiltinDictionary = snapshotDictionary(dictionary);

export const fairuxBuiltinRulePack: RulePack = Object.freeze({
  meta: fairuxBuiltinRulePackMeta,
  rules: allRules,
  dictionary: immutableBuiltinDictionary,
});
