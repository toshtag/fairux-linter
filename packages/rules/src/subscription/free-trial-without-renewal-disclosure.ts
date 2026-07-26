import type { Finding, Rule } from "@fairux/core";
import { reviewedGovernanceByRuleId } from "../generated/reviewed-governance.js";
import { staticTextAbsenceGovernance } from "../governance.js";
import { dictGroup, isControl, labelMatches, surroundingText } from "../helpers.js";

export const freeTrialWithoutRenewalDisclosure: Rule = {
  meta: {
    id: "subscription/free-trial-without-renewal-disclosure",
    title: "Free trial CTA lacks renewal disclosure",
    category: "subscription",
    defaultSeverity: "high",
    defaultConfidence: "medium",
    defaultEnabled: true,
    tags: ["subscription", "free-trial"],
    version: "1.0.0",
    ...staticTextAbsenceGovernance,
    ...reviewedGovernanceByRuleId["subscription/free-trial-without-renewal-disclosure"],
  },
  evaluate(doc, ctx): Finding[] {
    const renewal = dictGroup(ctx, "renewal");
    const findings: Finding[] = [];

    for (const node of doc.all()) {
      if (!isControl(ctx, node)) continue;
      const label = ctx.semantics.getControlLabel(node);
      if (!labelMatches(ctx, label, "freeTrial")) continue;

      // Disclosure counts if it appears anywhere in the control's surrounding section.
      if (ctx.text.hasAny(surroundingText(ctx, node), renewal)) continue;

      findings.push(
        ctx.createFinding({
          evidence: [{ locator: node.locator, text: label, source: node.source }],
          description: `A free-trial call to action ("${label}") has no nearby auto-renewal or billing-start disclosure.`,
          whyItMatters:
            "Users may read the action as free-only and miss that billing begins automatically when the trial ends.",
          recommendation:
            "Place the billing-start date, recurring price, and cancellation terms next to the trial CTA.",
        }),
      );
    }
    return findings;
  },
};
