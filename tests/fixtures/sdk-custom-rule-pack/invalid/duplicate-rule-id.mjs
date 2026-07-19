const rule = {
  meta: {
    id: "example/duplicate-rule",
    title: "Duplicate rule",
    category: "obstruction",
    defaultSeverity: "low",
    defaultConfidence: "low",
    defaultEnabled: true,
    tags: [],
    version: "1.0.0",
  },
  evaluate() {
    return [];
  },
};

export const invalidRulePack = {
  meta: {
    id: "example/duplicate-rule-pack",
    version: "0.1.0",
    engineApiVersion: "1",
    title: "Duplicate rule fixture",
    status: "stable",
  },
  rules: [rule, { ...rule }],
};

export const expectedError = {
  messagePattern: "Duplicate rule id",
};
