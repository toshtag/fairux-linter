import type { Finding, Rule } from "@fairux/core";
import { staticTextPresenceGovernance } from "../governance.js";
import { dictGroup, isCheckbox } from "../helpers.js";

const FTC = "https://www.ftc.gov/business-guidance/blog";
const TOPICS = ["terms", "privacy", "marketing", "thirdParty"] as const;

export const bundledConsent: Rule = {
  meta: {
    id: "consent/bundled-consent",
    title: "Bundled consent in a single control",
    category: "consent",
    defaultSeverity: "medium",
    defaultConfidence: "medium",
    defaultEnabled: true,
    tags: ["consent", "granularity"],
    version: "1.0.0",
    references: [FTC],
    ...staticTextPresenceGovernance,
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

      // A single consent control covering ≥2 distinct topics = bundled (no granular choice).
      if (topics.length >= 2 && expressesAgreement) {
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
