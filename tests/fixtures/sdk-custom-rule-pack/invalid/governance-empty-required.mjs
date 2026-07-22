export const invalidRulePack = {
  meta: {
    id: "example/governance-empty-required-pack",
    version: "0.1.0",
    engineApiVersion: "1",
    title: "Governance empty required fixture",
    status: "stable",
  },
  rules: [
    {
      meta: {
        id: "example/governance-empty-required-rule",
        title: "Governance empty required rule",
        category: "obstruction",
        defaultSeverity: "info",
        defaultConfidence: "low",
        defaultEnabled: true,
        tags: [],
        version: "1.0.0",
        maturity: "stable",
        requiredCapabilities: [],
        evidenceRequirements: ["presence"],
      },
      evaluate() {
        return [];
      },
    },
  ],
};

export const expectedError = {
  messagePattern: "requiredCapabilities",
};
