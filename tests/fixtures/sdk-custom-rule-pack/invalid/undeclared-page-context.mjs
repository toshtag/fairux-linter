export const invalidRulePack = {
  meta: {
    id: "purchase-guard/undeclared-context-pack",
    version: "0.1.0",
    engineApiVersion: "1",
    title: "Undeclared page context fixture",
    status: "stable",
  },
  taxonomy: {
    categories: [{ id: "purchase-guard/form-risk", title: "Form risk" }],
  },
  rules: [
    {
      meta: {
        id: "purchase-guard/context-rule",
        title: "Context rule",
        category: "purchase-guard/form-risk",
        defaultSeverity: "low",
        defaultConfidence: "medium",
        defaultEnabled: true,
        appliesTo: ["purchase-guard/checkout-form"],
        tags: [],
        version: "1.0.0",
      },
      evaluate() {
        return [];
      },
    },
  ],
};

export const expectedError = {
  messagePattern: "external page context must be declared",
};
