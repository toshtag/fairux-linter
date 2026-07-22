import type { Finding, Rule } from "@fairux/core";
import { modalStructureGovernance } from "../governance.js";
import { isCloseAction, isModalLike } from "../helpers.js";

const FTC = "https://www.ftc.gov/business-guidance/blog";

export const modalWithoutCloseAction: Rule = {
  meta: {
    id: "obstruction/modal-without-close-action",
    title: "Modal without a clear close control",
    category: "obstruction",
    // Low severity / medium confidence: static HTML can't observe JS, ESC, or outside-click closing.
    defaultSeverity: "low",
    defaultConfidence: "medium",
    defaultEnabled: true,
    tags: ["obstruction", "modal"],
    version: "1.0.0",
    references: [FTC],
    ...modalStructureGovernance,
  },
  evaluate(doc, ctx): Finding[] {
    const findings: Finding[] = [];
    for (const node of doc.all()) {
      if (!isModalLike(node)) continue;
      const hasClose = ctx.queries.descendants(node).some((d) => isCloseAction(ctx, d));
      if (hasClose) continue;

      findings.push(
        ctx.createFinding({
          evidence: [
            {
              locator: node.locator,
              text: node.directText || `<${node.tag}>`,
              source: node.source,
            },
          ],
          description:
            "A modal/dialog has no structurally detectable close control (button, link, or aria-label).",
          whyItMatters: "If users cannot easily dismiss a modal, it can trap them into an action.",
          recommendation:
            'Provide a clearly labeled close control (e.g. a button with aria-label="Close").',
          fingerprintText: node.locator.type === "css" ? node.locator.value : node.id,
        }),
      );
    }
    return findings;
  },
};
