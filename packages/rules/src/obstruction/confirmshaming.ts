import type { Finding, Rule } from "@fairux/core";
import { dictGroup, isControl } from "../helpers.js";

const FTC = "https://www.ftc.gov/business-guidance/blog";

export const confirmshaming: Rule = {
  meta: {
    id: "obstruction/confirmshaming",
    title: "Confirmshaming decline option",
    category: "obstruction",
    defaultSeverity: "medium",
    defaultConfidence: "medium",
    defaultEnabled: true,
    tags: ["obstruction", "confirmshaming", "consent"],
    version: "1.0.0",
    references: [FTC],
  },
  evaluate(doc, ctx): Finding[] {
    const patterns = dictGroup(ctx, "confirmShame");
    const findings: Finding[] = [];

    for (const node of doc.all()) {
      // Two-factor: it must be an interactive control AND its label must guilt-trip the user.
      // (Matching on a control's label, not body copy, is what keeps precision high.)
      if (!isControl(ctx, node)) continue;
      const label = ctx.semantics.getControlLabel(node);
      if (!label) continue;
      const match = ctx.text.findAny(ctx.text.normalize(label), patterns);
      if (!match) continue;

      findings.push(
        ctx.createFinding({
          evidence: [{ locator: node.locator, text: label, source: node.source }],
          description: `A decline/opt-out control uses guilt-tripping language: "${label}".`,
          whyItMatters:
            "Shaming users for declining (confirmshaming) pressures them into choices they didn't freely make.",
          recommendation:
            "Use neutral, respectful labels for the decline option (e.g. “No thanks” / “Not now”).",
          fingerprintText: match[0],
        }),
      );
    }
    return findings;
  },
};
