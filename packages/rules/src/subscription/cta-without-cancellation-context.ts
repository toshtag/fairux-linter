import type { Finding, Rule } from "@fairux/core";
import { reviewedGovernanceByRuleId } from "../generated/reviewed-governance.js";
import { staticTextAbsenceGovernance } from "../governance.js";
import { dictGroup, isControl, labelMatchesAffirmative, surroundingText } from "../helpers.js";

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
    // 1.2.0: a refusal is no longer read as the CTA it refuses. The finding used to name the decline
    // button, with its own evidence reading 「結構です、今は登録したくありません」 (#183). This rule's
    // own code is unchanged.
    // 1.3.0: shares the bounded-gap change in #187 — `/契約.*解除/` in the `cancellation` group is
    // consulted to decide whether cancellation terms are *absent* near a CTA, so an unbounded gap
    // silenced the finding rather than misfiring it.
    version: "1.3.0",
    ...staticTextAbsenceGovernance,
    ...reviewedGovernanceByRuleId["subscription/cta-without-cancellation-context"],
  },
  evaluate(doc, ctx): Finding[] {
    const cancellation = dictGroup(ctx, "cancellation");
    const findings: Finding[] = [];

    for (const node of doc.all()) {
      if (!isControl(ctx, node)) continue;
      const label = ctx.semantics.getControlLabel(node);
      if (!labelMatchesAffirmative(ctx, label, "subscribeCta")) continue;

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
