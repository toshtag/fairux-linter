import type { Finding, Rule } from "@fairux/core";
import { labelMatches } from "../helpers.js";

const FTC = "https://www.ftc.gov/business-guidance/blog";

export const missingRejectOption: Rule = {
  meta: {
    id: "consent/missing-reject-option",
    title: "Accept without a clear reject option",
    category: "consent",
    defaultSeverity: "medium",
    defaultConfidence: "medium",
    defaultEnabled: true,
    // Scoped to consent/marketing contexts so ordinary "agree & continue" flows don't trip it.
    appliesTo: ["consent", "marketing"],
    tags: ["consent"],
    version: "1.0.0",
    references: [FTC],
  },
  evaluate(doc, ctx): Finding[] {
    const controls = doc
      .all()
      .filter((n) => ctx.semantics.isButtonLike(n) || ctx.semantics.isLinkLike(n));

    const accepts = controls.filter((n) =>
      labelMatches(ctx, ctx.semantics.getControlLabel(n), "accept"),
    );
    const rejects = controls.filter((n) =>
      labelMatches(ctx, ctx.semantics.getControlLabel(n), "reject"),
    );

    const accept = accepts[0];
    if (!accept || rejects.length > 0) return [];

    return [
      ctx.createFinding({
        evidence: accepts.slice(0, 3).map((n) => ({
          locator: n.locator,
          text: ctx.semantics.getControlLabel(n),
          source: n.source,
        })),
        description:
          "An accept/agree control is present, but no clear reject, decline, or manage-preferences option was found.",
        whyItMatters:
          "Without an equally available way to refuse, consent is not a free and informed choice.",
        recommendation:
          "Offer a clearly visible reject/decline (or manage preferences) option alongside accept.",
        fingerprintText: ctx.semantics.getControlLabel(accept),
      }),
    ];
  },
};
