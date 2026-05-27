import type { Finding, Rule } from "@fairux/core";
import { dictGroup, isControl, labelMatches, surroundingText } from "../helpers.js";

const FTC = "https://www.ftc.gov/business-guidance/blog";

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
    version: "1.0.0",
    references: [FTC],
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
