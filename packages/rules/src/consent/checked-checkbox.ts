import type { Finding, Rule, RuleContext, Severity } from "@fairux/core";
import { reviewedGovernanceByRuleId } from "../generated/reviewed-governance.js";
import { attributeStateGovernance } from "../governance.js";
import { isCheckbox, isChecked, labelMatches } from "../helpers.js";
import { removeCheckedAttributeRemediation } from "../remediation.js";

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
    // 1.1.0: bounded gaps in the shared `thirdParty` group (#187). `/\bshare\b.*\bdata\b/` matched
    // "share this article … we never sell your data" — presence rather than absence here, so it
    // misfired visibly rather than going quiet.
    //
    // 1.2.0: findings on a document that recorded source ranges now carry a `safe` remediation that
    // deletes the `checked` attribute. Detection is unchanged — the same pages produce the same
    // findings — but a finding is a different shape than it was, so the version moves.
    version: "1.2.0",
    ...attributeStateGovernance,
    ...reviewedGovernanceByRuleId["consent/checked-checkbox"],
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

      // Absent unless the document recorded where the attribute is, what that range currently
      // holds, and the checksum of the bytes both were read from — see the module for what each
      // missing piece means. A finding without one is the same finding it has always been.
      const remediation = removeCheckedAttributeRemediation(doc, node, {
        ruleId: checkedCheckbox.meta.id,
        label,
      });

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
          ...(remediation ? { remediation } : {}),
        }),
      );
    }
    return findings;
  },
};
