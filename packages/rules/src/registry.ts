import type { Rule } from "@fairux/core";
import { bundledConsent } from "./consent/bundled-consent.js";
import { checkedCheckbox } from "./consent/checked-checkbox.js";
import { missingRejectOption } from "./consent/missing-reject-option.js";
import { ctaWithoutCancellationContext } from "./subscription/cta-without-cancellation-context.js";
import { freeTrialWithoutRenewalDisclosure } from "./subscription/free-trial-without-renewal-disclosure.js";

export const consentRules: Rule[] = [checkedCheckbox, missingRejectOption, bundledConsent];

export const subscriptionRules: Rule[] = [
  freeTrialWithoutRenewalDisclosure,
  ctaWithoutCancellationContext,
];

/** Every rule FairUX ships. Surfaces (CLI etc.) scan with this list. */
export const allRules: Rule[] = [...consentRules, ...subscriptionRules];
