export const purchaseGuardRulePack = {
  meta: {
    id: "@purchase-guard/jp-commerce",
    version: "0.0.0-test.0",
    engineApiVersion: "1",
    title: "Purchase Guard integration fixture",
    status: "experimental",
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
        maturity: "stable",
        requiredCapabilities: ["structure", "text"],
        evidenceRequirements: ["presence"],
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
        maturity: "stable",
        requiredCapabilities: ["structure", "text"],
        evidenceRequirements: ["presence"],
      },
      evaluate(doc, ctx) {
        const hasInput = doc.all().some((node) => node.tag === "input");
        const hasReturnPolicy = doc
          .all()
          .some((node) => /return policy|返品|返金/.test(node.normalizedText));
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

export const rulePack = purchaseGuardRulePack;
export const scanHtmlInput =
  "<main><form><input name='email'><button>Buy now</button></form></main>";
export const pageContexts = [{ context: "purchase-guard/checkout-form", confidence: "high" }];
export const expectedRuleIds = [
  "purchase-guard/missing-return-policy",
  "purchase-guard/checkout-form-return-policy",
];
export const expectedCategoryIds = ["purchase-guard/return-policy"];
export const expectedPageContextIds = ["purchase-guard/checkout-form"];
