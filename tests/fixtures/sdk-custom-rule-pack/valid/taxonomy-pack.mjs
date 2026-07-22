export const rulePack = {
  meta: {
    id: "@purchase-guard/taxonomy-demo",
    version: "0.1.0",
    engineApiVersion: "1",
    title: "Taxonomy authoring fixture",
    status: "stable",
  },
  taxonomy: {
    categories: [
      {
        id: "purchase-guard/checkout-transparency",
        title: "Checkout transparency",
        parentId: "hidden-cost",
      },
      {
        id: "purchase-guard/return-policy",
        title: "Return policy",
        parentId: "purchase-guard/checkout-transparency",
      },
    ],
  },
  rules: [
    {
      meta: {
        id: "purchase-guard/return-policy-link",
        title: "Return policy link",
        category: "purchase-guard/return-policy",
        defaultSeverity: "low",
        defaultConfidence: "medium",
        defaultEnabled: true,
        tags: ["authoring-fixture"],
        version: "1.0.0",
        maturity: "stable",
        requiredCapabilities: ["structure", "text"],
        evidenceRequirements: ["presence"],
      },
      evaluate(doc, ctx) {
        const hasReturnPolicy = doc
          .all()
          .some((node) => /return policy|refund|exchange/i.test(node.subtreeText));
        if (hasReturnPolicy) return [];
        return [
          ctx.createFinding({
            evidence: [{ locator: doc.root.locator, text: doc.root.subtreeText }],
            description: "No return-policy text or link was found in the scanned checkout content.",
            whyItMatters: "The scan can only report that expected copy was not found in scope.",
            recommendation: "Add a return policy link near the purchase action.",
          }),
        ];
      },
    },
  ],
};

export const scanHtmlInput = "<main><button>Place order</button></main>";
export const expectedRuleIds = ["purchase-guard/return-policy-link"];
export const expectedCategoryIds = [
  "purchase-guard/checkout-transparency",
  "purchase-guard/return-policy",
];
