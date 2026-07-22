export const rulePack = {
  meta: {
    id: "purchase-guard/page-context-demo",
    version: "0.1.0",
    engineApiVersion: "1",
    title: "Page context authoring fixture",
    status: "stable",
  },
  taxonomy: {
    categories: [{ id: "purchase-guard/form-risk", title: "Form risk" }],
    pageContexts: [{ id: "purchase-guard/checkout-form", title: "Checkout form" }],
  },
  rules: [
    {
      meta: {
        id: "purchase-guard/context-gated-form",
        title: "Context gated form",
        category: "purchase-guard/form-risk",
        defaultSeverity: "low",
        defaultConfidence: "medium",
        defaultEnabled: true,
        appliesTo: ["purchase-guard/checkout-form"],
        tags: ["authoring-fixture"],
        version: "1.0.0",
        maturity: "stable",
        requiredCapabilities: ["structure", "text"],
        evidenceRequirements: ["presence"],
      },
      evaluate(doc, ctx) {
        const hasInput = doc.all().some((node) => node.tag === "input");
        if (!hasInput) return [];
        return [
          ctx.createFinding({
            evidence: [{ locator: doc.root.locator, text: doc.root.subtreeText }],
            description: "A form input was found in a caller-supplied checkout context.",
            whyItMatters:
              "External page contexts are declarations plus caller-supplied scan facts.",
            recommendation: "Review checkout form copy in the supplied context.",
          }),
        ];
      },
    },
  ],
};

export const scanHtmlInput = "<main><form><input name='email'><button>Buy</button></form></main>";
export const pageContexts = [{ context: "purchase-guard/checkout-form", confidence: "high" }];
export const expectedRuleIds = ["purchase-guard/context-gated-form"];
export const expectedPageContextIds = ["purchase-guard/checkout-form"];
