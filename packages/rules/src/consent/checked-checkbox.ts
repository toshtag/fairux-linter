import type { Finding, Rule, RuleContext, Severity } from "@fairux/core";
import { isCheckbox, isChecked, labelMatches } from "../helpers.js";

const FTC = "https://www.ftc.gov/business-guidance/blog";

/** Severity scaled by what the user is being pre-opted into (null = not consent-ish by label). */
function severityForLabel(ctx: RuleContext, label: string): Severity | null {
  if (labelMatches(ctx, label, "marketing") || labelMatches(ctx, label, "thirdParty"))
    return "high";
  if (labelMatches(ctx, label, "terms") || labelMatches(ctx, label, "privacy")) return "medium";
  if (labelMatches(ctx, label, "mildConsent")) return "low";
  return null;
}

export const checkedCheckbox: Rule = {
  meta: {
    id: "consent/checked-checkbox",
    title: "Pre-checked consent box",
    category: "consent",
    defaultSeverity: "medium",
    defaultConfidence: "high",
    defaultEnabled: true,
    tags: ["consent", "opt-in"],
    version: "1.0.0",
    references: [FTC],
  },
  evaluate(doc, ctx): Finding[] {
    const onConsentPage = ctx
      .getPageContexts()
      .some(
        (s) => s.context === "consent" || s.context === "marketing" || s.context === "subscription",
      );

    const findings: Finding[] = [];
    for (const node of doc.all()) {
      if (!isCheckbox(node) || !isChecked(node)) continue;

      const label = ctx.semantics.getControlLabel(node);
      const labelSeverity = severityForLabel(ctx, label);

      // Only flag pre-checked boxes that look like consent — by label, or by page context.
      // A pre-checked filter/toggle on an ordinary page is not a dark pattern.
      let severity: Severity;
      if (labelSeverity) severity = labelSeverity;
      else if (onConsentPage) severity = "medium";
      else continue;

      findings.push(
        ctx.createFinding({
          severity,
          evidence: [
            { locator: node.locator, text: label || "(unlabeled checkbox)", source: node.source },
          ],
          description: `A checkbox is checked by default${label ? `: "${label}"` : ""}.`,
          whyItMatters: "Pre-checked boxes opt users in without an active, informed choice.",
          recommendation:
            "Leave consent and marketing checkboxes unchecked so users opt in deliberately.",
        }),
      );
    }
    return findings;
  },
};
