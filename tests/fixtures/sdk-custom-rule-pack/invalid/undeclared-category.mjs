export const invalidRulePack = {
  meta: {
    id: "purchase-guard/undeclared-category-pack",
    version: "0.1.0",
    engineApiVersion: "1",
    title: "Undeclared category fixture",
    status: "stable",
  },
  rules: [
    {
      meta: {
        id: "purchase-guard/undeclared-category-rule",
        title: "Undeclared category",
        category: "purchase-guard/return-policy",
        defaultSeverity: "low",
        defaultConfidence: "medium",
        defaultEnabled: true,
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
  messagePattern: "external category must be declared",
};
