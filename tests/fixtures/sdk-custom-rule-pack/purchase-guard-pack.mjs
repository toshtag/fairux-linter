export const purchaseGuardRulePack = {
  meta: {
    id: "@purchase-guard/jp-commerce",
    version: "0.0.0-test.0",
    engineApiVersion: "1",
    title: "Purchase Guard integration fixture",
    status: "experimental",
  },
  rules: [
    {
      meta: {
        id: "@purchase-guard/missing-return-policy",
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
          .some((node) => /return policy|返品|返金/.test(node.normalizedText));
        if (hasReturnPolicy) return [];
        return [
          ctx.createFinding({
            evidence: [{ locator: doc.root.locator, text: doc.root.subtreeText }],
            description: "No return policy copy was found near the purchase flow.",
            whyItMatters: "Return terms are a consumer-protection signal.",
            recommendation: "Link to the return policy before checkout.",
          }),
        ];
      },
    },
  ],
};
