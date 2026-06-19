import type { Rule } from "@fairux/core";
import { missingCancellationLink } from "./cancellation/missing-cancellation-link.js";
import { acceptRejectVisualImbalance } from "./consent/accept-reject-visual-imbalance.js";
import { bundledConsent } from "./consent/bundled-consent.js";
import { checkedCheckbox } from "./consent/checked-checkbox.js";
import { missingRejectOption } from "./consent/missing-reject-option.js";
import { priceNearCheckoutWithoutFeeDisclosure } from "./hidden-cost/price-near-checkout-without-fee-disclosure.js";
import { modalCloseVisibility } from "./obstruction/modal-close-visibility.js";
import { modalWithoutCloseAction } from "./obstruction/modal-without-close-action.js";
import { scarcityPhrase } from "./scarcity/scarcity-phrase.js";
import { ctaWithoutCancellationContext } from "./subscription/cta-without-cancellation-context.js";
import { freeTrialWithoutRenewalDisclosure } from "./subscription/free-trial-without-renewal-disclosure.js";

export const consentRules: Rule[] = [checkedCheckbox, missingRejectOption, bundledConsent];

export const subscriptionRules: Rule[] = [
  freeTrialWithoutRenewalDisclosure,
  ctaWithoutCancellationContext,
];

export const cancellationRules: Rule[] = [missingCancellationLink];

export const scarcityRules: Rule[] = [scarcityPhrase];

export const hiddenCostRules: Rule[] = [priceNearCheckoutWithoutFeeDisclosure];

export const obstructionRules: Rule[] = [modalWithoutCloseAction];

/** Experimental rules: disabled by default; run only when explicitly enabled. */
export const experimentalRules: Rule[] = [acceptRejectVisualImbalance, modalCloseVisibility];

/** Every rule FairUX ships (enabled + experimental). scan() filters experimental ones out by default. */
export const allRules: Rule[] = [
  ...consentRules,
  ...subscriptionRules,
  ...cancellationRules,
  ...scarcityRules,
  ...hiddenCostRules,
  ...obstructionRules,
  ...experimentalRules,
];
