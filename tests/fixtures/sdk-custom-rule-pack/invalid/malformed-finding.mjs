export const invalidRulePack = {
  meta: {
    id: "example/malformed-finding-pack",
    version: "0.1.0",
    engineApiVersion: "1",
    title: "Malformed finding fixture",
    status: "stable",
  },
  rules: [
    {
      meta: {
        id: "example/malformed-finding-rule",
        title: "Malformed finding",
        category: "obstruction",
        defaultSeverity: "low",
        defaultConfidence: "medium",
        defaultEnabled: true,
        tags: [],
        version: "1.0.0",
      },
      evaluate(doc, ctx) {
        return [
          ctx.createFinding({
            severity: "critical",
            evidence: [{ locator: doc.root.locator, text: doc.root.subtreeText }],
            description: "Invalid severity.",
            whyItMatters: "Rule output must preserve the public report schema.",
            recommendation: "Return a valid FairUX severity.",
          }),
        ];
      },
    },
  ],
};

export const invalidExpectation = "scan";
export const scanHtmlInput = "<main><button>Buy now</button></main>";
export const expectedError = {
  messagePattern: "severity",
};
