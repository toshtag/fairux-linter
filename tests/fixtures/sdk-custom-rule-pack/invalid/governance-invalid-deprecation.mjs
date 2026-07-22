export const invalidRulePack = {
  meta: {
    id: "example/governance-invalid-deprecation-pack",
    version: "0.1.0",
    engineApiVersion: "1",
    title: "Governance invalid deprecation fixture",
    status: "stable",
  },
  rules: [
    {
      meta: {
        id: "example/governance-invalid-deprecation-rule",
        title: "Governance invalid deprecation rule",
        category: "obstruction",
        defaultSeverity: "info",
        defaultConfidence: "low",
        defaultEnabled: true,
        tags: [],
        version: "1.0.0",
        maturity: "deprecated",
        requiredCapabilities: ["structure", "text"],
        evidenceRequirements: ["presence"],
        deprecation: {
          since: "0.1.0",
          reason: "This fixture should be rejected.",
          removalTarget: "1.0.0",
          unknown: true,
        },
      },
      evaluate() {
        return [];
      },
    },
  ],
};

export const expectedError = {
  messagePattern: "unknown field",
};
