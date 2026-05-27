import type { Rule } from "@fairux/core";
import { bundledConsent } from "./consent/bundled-consent.js";
import { checkedCheckbox } from "./consent/checked-checkbox.js";
import { missingRejectOption } from "./consent/missing-reject-option.js";

export const consentRules: Rule[] = [checkedCheckbox, missingRejectOption, bundledConsent];

/** Every rule FairUX ships. Surfaces (CLI etc.) scan with this list. */
export const allRules: Rule[] = [...consentRules];
