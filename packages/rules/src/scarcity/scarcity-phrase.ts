import type { Finding, Rule } from "@fairux/core";
import { reviewedGovernanceByRuleId } from "../generated/reviewed-governance.js";
import { staticTextPresenceGovernance } from "../governance.js";
import { dictGroup } from "../helpers.js";

export const scarcityPhrase: Rule = {
  meta: {
    id: "scarcity/scarcity-phrase",
    title: "Scarcity or urgency phrasing",
    category: "scarcity",
    defaultSeverity: "low",
    defaultConfidence: "medium",
    defaultEnabled: true,
    tags: ["scarcity", "urgency"],
    version: "1.0.0",
    ...staticTextPresenceGovernance,
    ...reviewedGovernanceByRuleId["scarcity/scarcity-phrase"],
  },
  evaluate(doc, ctx): Finding[] {
    const patterns = dictGroup(ctx, "scarcity");
    const findings: Finding[] = [];

    // Match on directText (own text only) so a phrase is reported once, at its owning node.
    for (const node of doc.all()) {
      if (!node.directText) continue;
      const match = ctx.text.findAny(ctx.text.normalize(node.directText), patterns);
      if (!match) continue;

      findings.push(
        ctx.createFinding({
          evidence: [{ locator: node.locator, text: node.directText, source: node.source }],
          description: `Possible scarcity/urgency phrasing: "${node.directText}".`,
          whyItMatters: "Unverified scarcity or urgency can pressure users into rushed decisions.",
          recommendation:
            "Use scarcity/urgency claims only when backed by real, current data; avoid artificial pressure.",
          fingerprintText: match[0],
        }),
      );
    }
    return findings;
  },
};
