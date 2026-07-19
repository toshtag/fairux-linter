import type { Finding, Rule, RuleContext, UiNode } from "@fairux/core";
import { hasClassLike, isControl, labelMatches, styleMap } from "../helpers.js";

const FTC = "https://www.ftc.gov/business-guidance/blog";

/** Rough visual-prominence score from class/inline-style hints (static HTML has no layout). */
function prominence(ctx: RuleContext, node: UiNode): number {
  let score = 0;
  if (ctx.semantics.isButtonLike(node)) score += 2;
  if (hasClassLike(node, ["primary", "cta", "btn-primary", "accept", "confirm"])) score += 2;
  if (hasClassLike(node, ["secondary", "tertiary", "ghost", "text", "muted", "subtle", "link"])) {
    score -= 2;
  }
  const style = styleMap(node);
  const fontWeight = style["font-weight"];
  if (fontWeight === "bold" || Number(fontWeight) >= 600) score += 1;
  const opacity = Number(style.opacity);
  if (!Number.isNaN(opacity) && opacity < 0.8) score -= 1;
  if (ctx.semantics.isLinkLike(node) && !ctx.semantics.isButtonLike(node)) score -= 1;
  return score;
}

export const acceptRejectVisualImbalance: Rule = {
  meta: {
    id: "consent/accept-reject-visual-imbalance",
    title: "Accept/reject visual imbalance (experimental)",
    category: "visual-asymmetry",
    defaultSeverity: "info",
    defaultConfidence: "low",
    defaultEnabled: false,
    experimental: true,
    tags: ["consent", "visual", "experimental"],
    version: "1.0.0",
    references: [FTC],
  },
  evaluate(doc, ctx): Finding[] {
    const controls = doc.all().filter((n) => isControl(ctx, n));
    const accept = controls.find((n) =>
      labelMatches(ctx, ctx.semantics.getControlLabel(n), "accept"),
    );
    const reject = controls.find((n) =>
      labelMatches(ctx, ctx.semantics.getControlLabel(n), "reject"),
    );
    if (!accept || !reject) return [];
    if (prominence(ctx, accept) - prominence(ctx, reject) < 3) return [];

    return [
      ctx.createFinding({
        evidence: [
          {
            locator: accept.locator,
            text: ctx.semantics.getControlLabel(accept),
            source: accept.source,
          },
          {
            locator: reject.locator,
            text: ctx.semantics.getControlLabel(reject),
            source: reject.source,
          },
        ],
        description:
          "The accept option appears visually stronger than the reject option (heuristic).",
        whyItMatters:
          "Making the reject option visually weaker nudges users toward accepting, undermining free choice.",
        recommendation: "Give accept and reject comparable visual prominence.",
        fingerprintText: "accept-reject-visual-imbalance",
      }),
    ];
  },
};
