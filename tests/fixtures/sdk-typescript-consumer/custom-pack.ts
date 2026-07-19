import type { RulePack } from "@fairux/sdk";

export const purchaseGuardRulePack: RulePack = {
  meta: {
    id: "purchase-guard/typescript-fixture",
    version: "0.1.0",
    engineApiVersion: "1",
    title: "Purchase Guard TypeScript Fixture",
    status: "stable",
  },
  rules: [
    {
      meta: {
        id: "purchase-guard/missing-return-policy",
        title: "Missing return policy",
        category: "hidden-cost",
        defaultSeverity: "low",
        defaultConfidence: "medium",
        defaultEnabled: true,
        tags: ["purchase-guard"],
        version: "1.0.0",
      },
      evaluate(doc, ctx) {
        const hasReturnPolicy = doc
          .all()
          .some((node) => /return policy|返品/.test(node.normalizedText));
        if (hasReturnPolicy) return [];
        return [
          ctx.createFinding({
            evidence: [{ locator: doc.root.locator, text: doc.root.subtreeText }],
            description: "No return policy copy was found.",
            whyItMatters: "Return terms are a consumer-protection signal.",
            recommendation: "Link to the return policy near checkout.",
          }),
        ];
      },
    },
  ],
};
