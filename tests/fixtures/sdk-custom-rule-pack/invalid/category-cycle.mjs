export const invalidRulePack = {
  meta: {
    id: "purchase-guard/category-cycle-pack",
    version: "0.1.0",
    engineApiVersion: "1",
    title: "Category cycle fixture",
    status: "stable",
  },
  taxonomy: {
    categories: [
      { id: "purchase-guard/a", title: "A", parentId: "purchase-guard/b" },
      { id: "purchase-guard/b", title: "B", parentId: "purchase-guard/a" },
    ],
  },
  rules: [],
};

export const expectedError = {
  messagePattern: "cyclic taxonomy category parents",
};
