import type { Finding, Rule } from "@fairux/core";
import { reviewedGovernanceByRuleId } from "../generated/reviewed-governance.js";
import { staticTextPresenceGovernance } from "../governance.js";
import { dictGroup, isCheckbox } from "../helpers.js";

const TOPICS = ["terms", "privacy", "marketing", "thirdParty"] as const;

/**
 * What counts as one consent.
 *
 * `terms` and `privacy` are the same agreement: a user cannot accept a service and decline its
 * privacy policy, so a checkbox naming both denies no granular choice and the finding has nothing to
 * recommend. Counting them separately flagged the shape this rule asks for — marketing on its own
 * control, terms and privacy together (#192).
 *
 * The reading was checked against the alternative, "fire only when a declinable consent shares a
 * control", and the two agree on every combination of the four topics. This is the simpler of two
 * equivalent statements.
 */
function consentTopic(topic: (typeof TOPICS)[number]): string {
  return topic === "terms" || topic === "privacy" ? "agreement" : topic;
}

export const bundledConsent: Rule = {
  meta: {
    id: "consent/bundled-consent",
    title: "Bundled consent in a single control",
    category: "consent",
    defaultSeverity: "medium",
    defaultConfidence: "medium",
    defaultEnabled: true,
    tags: ["consent", "granularity"],
    // 1.1.0: bounded gaps in the shared `thirdParty` group (#187). `/\bshare\b.*\bdata\b/` matched
    // "share this article … we never sell your data" — presence rather than absence here, so it
    // misfired visibly rather than going quiet.
    // 1.2.0: the terms and the privacy policy count as one consent, not two (#192). This rule flagged
    // the exact shape it recommends — marketing on its own control, the agreement on another.
    version: "1.2.0",
    ...staticTextPresenceGovernance,
    ...reviewedGovernanceByRuleId["consent/bundled-consent"],
  },
  evaluate(doc, ctx): Finding[] {
    const findings: Finding[] = [];
    for (const node of doc.all()) {
      if (!isCheckbox(node)) continue;

      const label = ctx.semantics.getControlLabel(node);
      if (!label) continue;
      const normalized = ctx.text.normalize(label);

      const topics = TOPICS.filter((t) => ctx.text.hasAny(normalized, dictGroup(ctx, t)));
      const expressesAgreement = ctx.text.hasAny(normalized, dictGroup(ctx, "accept"));
      const distinct = new Set(topics.map(consentTopic));

      // A single consent control covering ≥2 distinct consents = bundled (no granular choice).
      if (distinct.size >= 2 && expressesAgreement) {
        findings.push(
          ctx.createFinding({
            evidence: [{ locator: node.locator, text: label, source: node.source }],
            description: `A single consent control bundles multiple topics: ${topics.join(", ")}.`,
            whyItMatters:
              "Bundling unrelated consents into one control denies users a granular, informed choice.",
            recommendation:
              "Split distinct consents (e.g. terms vs. marketing) into separate, independent controls.",
          }),
        );
      }
    }
    return findings;
  },
};
