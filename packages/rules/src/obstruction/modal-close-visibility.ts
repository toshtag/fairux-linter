import type { Finding, Rule, UiNode } from "@fairux/core";
import { hasClassLike, isCloseAction, isModalLike, parsePx, styleMap } from "../helpers.js";

const FTC = "https://www.ftc.gov/business-guidance/blog";

/** Heuristic "hard to see" from inline style / class hints (static HTML has no computed style). */
function looksHardToSee(node: UiNode): boolean {
  const style = styleMap(node);
  const opacity = Number(style.opacity);
  if (!Number.isNaN(opacity) && opacity < 0.5) return true;
  const fontSize = parsePx(style["font-size"]);
  if (fontSize !== undefined && fontSize < 10) return true;
  return hasClassLike(node, ["tiny", "sr-only", "visually-hidden", "invisible", "hidden"]);
}

export const modalCloseVisibility: Rule = {
  meta: {
    id: "obstruction/modal-close-visibility",
    title: "Modal close control may be hard to see (experimental)",
    category: "obstruction",
    defaultSeverity: "info",
    defaultConfidence: "low",
    defaultEnabled: false,
    experimental: true,
    tags: ["obstruction", "modal", "visual", "experimental"],
    version: "1.0.0",
    references: [FTC],
  },
  evaluate(doc, ctx): Finding[] {
    const findings: Finding[] = [];
    for (const node of doc.all()) {
      if (!isModalLike(node)) continue;
      const close = ctx.queries.descendants(node).find((d) => isCloseAction(ctx, d));
      if (!close || !looksHardToSee(close)) continue; // "no close at all" is the other rule's job

      findings.push(
        ctx.createFinding({
          evidence: [
            {
              locator: close.locator,
              text: ctx.semantics.getControlLabel(close) || "(close)",
              source: close.source,
            },
          ],
          description:
            "A modal close control is present but looks visually de-emphasized (heuristic).",
          whyItMatters:
            "A hard-to-see close control makes a modal effectively difficult to dismiss.",
          recommendation: "Ensure the close control has clear size, contrast, and opacity.",
          fingerprintText: "modal-close-visibility",
        }),
      );
    }
    return findings;
  },
};
