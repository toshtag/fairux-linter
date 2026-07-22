import type { Rule, RuleMeta } from "@fairux/sdk";

export const missingReturnPolicyMeta = {
  id: "purchase-guard/missing-return-policy",
  title: "Missing return policy",
  category: "purchase-guard/return-policy",
  defaultSeverity: "low",
  defaultConfidence: "medium",
  defaultEnabled: true,
  appliesTo: ["purchase-guard/checkout-form"],
  tags: ["purchase-guard", "return-policy"],
  version: "1.0.0",
  maturity: "stable",
  requiredCapabilities: ["structure", "text"],
  evidenceRequirements: ["presence", "text-match"],
} satisfies RuleMeta;

export const missingReturnPolicyRule = {
  meta: missingReturnPolicyMeta,
  evaluate(doc, ctx) {
    const hasReturnPolicy = doc
      .all()
      .some((node) => /return policy|refund|exchange|返品|返金/.test(node.normalizedText));
    if (hasReturnPolicy) return [];

    return [
      ctx.createFinding({
        evidence: [{ locator: doc.root.locator, text: doc.root.subtreeText }],
        description: "No return-policy text or link was found in the scanned checkout content.",
        whyItMatters:
          "This is a UX risk signal for human review, not a legal or fraud verdict.",
        recommendation: "Add a visible return policy link near the checkout form.",
      }),
    ];
  },
} satisfies Rule;
