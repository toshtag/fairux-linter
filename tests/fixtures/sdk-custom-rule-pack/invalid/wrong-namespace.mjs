export const invalidRulePack = {
  meta: {
    id: "@purchase-guard/jp-commerce",
    version: "0.1.0",
    engineApiVersion: "1",
    title: "Wrong namespace fixture",
    status: "stable",
  },
  taxonomy: {
    categories: [{ id: "seller-guard/return-policy", title: "Return policy" }],
  },
  rules: [],
};

export const expectedError = {
  messagePattern: "expected namespace purchase-guard",
};
