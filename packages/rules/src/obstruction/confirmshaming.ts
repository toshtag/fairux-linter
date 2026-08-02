import type { Finding, Rule } from "@fairux/core";
import { reviewedGovernanceByRuleId } from "../generated/reviewed-governance.js";
import { staticComparisonGovernance } from "../governance.js";
import { dictGroup, isControl } from "../helpers.js";

export const confirmshaming: Rule = {
  meta: {
    id: "obstruction/confirmshaming",
    title: "Confirmshaming decline option",
    category: "obstruction",
    defaultSeverity: "medium",
    defaultConfidence: "medium",
    defaultEnabled: true,
    tags: ["obstruction", "confirmshaming", "consent"],
    // 1.1.0, and one version for both halves of the same correction. Two patterns that gated on a
    // refusal's opening are gone, and four clauses that name what is being given up have arrived —
    // including the one the corpus recorded as a miss on its first run. Detection narrows on the
    // ordinary declines and widens on the guilt clauses, which is the same change seen from either
    // end. The major holds, so a baseline tracking existing findings does not renumber.
    // Bounded gaps in the Japanese guilt clause (#187). Presence rather than absence here, so the old
    // pattern misfired visibly rather than going quiet — bounded anyway, because "these words both
    // appear somewhere on the page" is almost never what a pattern author means.
    version: "1.2.0",
    ...staticComparisonGovernance,
    ...reviewedGovernanceByRuleId["obstruction/confirmshaming"],
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
