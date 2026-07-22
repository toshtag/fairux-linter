export const invalidRulePack = {
  meta: {
    id: "example/governance-invalid-source-pack",
    version: "0.1.0",
    engineApiVersion: "1",
    title: "Governance invalid source fixture",
    status: "stable",
  },
  rules: [
    {
      meta: {
        id: "example/governance-invalid-source-rule",
        title: "Governance invalid source rule",
        category: "obstruction",
        defaultSeverity: "info",
        defaultConfidence: "low",
        defaultEnabled: true,
        tags: [],
        version: "1.0.0",
        maturity: "stable",
        requiredCapabilities: ["structure", "text"],
        evidenceRequirements: ["presence"],
        officialSources: [
          {
            id: "regulator/insecure-source",
            title: "Insecure source",
            publisher: "Example regulator",
            url: "http://example.test/insecure-source",
            reviewedAt: "2026-07-22",
          },
        ],
      },
      evaluate() {
        return [];
      },
    },
  ],
};

export const expectedError = {
  messagePattern: "absolute HTTPS URL",
};
