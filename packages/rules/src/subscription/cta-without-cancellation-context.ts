import type { Finding, Rule } from "@fairux/core";
import { reviewedGovernanceByRuleId } from "../generated/reviewed-governance.js";
import { staticTextAbsenceGovernance } from "../governance.js";
import { dictGroup, isControl, labelMatches, surroundingText } from "../helpers.js";

export const ctaWithoutCancellationContext: Rule = {
  meta: {
    id: "subscription/cta-without-cancellation-context",
    title: "Subscribe CTA without cancellation context",
    category: "subscription",
    defaultSeverity: "medium",
    defaultConfidence: "medium",
    defaultEnabled: true,
    // Commerce pages only, so a generic "sign up" elsewhere doesn't trip it.
    appliesTo: ["subscription", "pricing", "checkout"],
    tags: ["subscription", "cancellation"],
    // 1.1.0, with this rule's own code unchanged. `subscribe` left the `subscription` page-context
    // keywords, so the rule stopped firing on free newsletter signups — a version exists to say when
    // a rule's behaviour changed, and this one's did. The major holds, so fingerprints do not move.
    version: "1.1.0",
    ...staticTextAbsenceGovernance,
    ...reviewedGovernanceByRuleId["subscription/cta-without-cancellation-context"],
  },
  evaluate(doc, ctx): Finding[] {
    const cancellation = dictGroup(ctx, "cancellation");
    const findings: Finding[] = [];

    for (const node of doc.all()) {
      if (!isControl(ctx, node)) continue;
      const label = ctx.semantics.getControlLabel(node);
      if (!labelMatches(ctx, label, "subscribeCta")) continue;

      if (ctx.text.hasAny(surroundingText(ctx, node), cancellation)) continue;

      findings.push(
        ctx.createFinding({
          evidence: [{ locator: node.locator, text: label, source: node.source }],
          description: `A subscription call to action ("${label}") has no nearby cancellation terms.`,
          whyItMatters:
            "Users commit to recurring billing without seeing how (or whether) they can cancel.",
          recommendation:
            "Show cancellation terms (e.g. “cancel anytime” and how) next to the subscribe CTA.",
        }),
      );
    }
    return findings;
  },
};
