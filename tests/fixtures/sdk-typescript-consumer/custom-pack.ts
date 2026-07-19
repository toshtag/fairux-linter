import type { RulePack } from "@fairux/sdk";

export const purchaseGuardRulePack: RulePack = {
  meta: {
    id: "@purchase-guard/typescript-fixture",
    version: "0.1.0",
    engineApiVersion: "1",
    title: "Purchase Guard TypeScript Fixture",
    status: "stable",
  },
  taxonomy: {
    categories: [
      {
        id: "purchase-guard/return-policy",
        title: "Return policy",
        description: "Signals about return, refund, or exchange terms in purchase flows.",
      },
    ],
    pageContexts: [
      {
        id: "purchase-guard/checkout-form",
        title: "Checkout form",
        description: "Checkout forms where purchase terms should be visible before submission.",
      },
    ],
  },
  rules: [
    {
      meta: {
        id: "purchase-guard/missing-return-policy",
        title: "Missing return policy",
        category: "purchase-guard/return-policy",
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
    {
      meta: {
        id: "purchase-guard/checkout-form-return-policy",
        title: "Checkout form missing return policy",
        category: "purchase-guard/return-policy",
        defaultSeverity: "low",
        defaultConfidence: "medium",
        defaultEnabled: true,
        appliesTo: ["purchase-guard/checkout-form"],
        tags: ["purchase-guard"],
        version: "1.0.0",
      },
      evaluate(doc, ctx) {
        const hasInput = doc.all().some((node) => node.tag === "input");
        const hasReturnPolicy = doc
          .all()
          .some((node) => /return policy|返品/.test(node.normalizedText));
        if (!hasInput || hasReturnPolicy) return [];
        return [
          ctx.createFinding({
            evidence: [{ locator: doc.root.locator, text: doc.root.subtreeText }],
            description: "A checkout form was found without nearby return policy copy.",
            whyItMatters: "Return terms should be visible before a buyer submits checkout details.",
            recommendation: "Add a return policy link near the checkout form.",
          }),
        ];
      },
    },
  ],
};
