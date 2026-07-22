export const rulePack = {
  meta: {
    id: "example/governance-pack",
    version: "0.1.0",
    engineApiVersion: "1",
    title: "Governance authoring fixture",
    status: "stable",
  },
  rules: [
    {
      meta: {
        id: "example/governance-rule",
        title: "Governance rule",
        category: "obstruction",
        defaultSeverity: "info",
        defaultConfidence: "low",
        defaultEnabled: true,
        tags: ["authoring-fixture"],
        version: "1.0.0",
        maturity: "stable",
        requiredCapabilities: ["structure", "text"],
        optionalCapabilities: ["computed-style"],
        evidenceRequirements: ["presence", "text-match"],
        jurisdictions: ["US"],
        officialSources: [
          {
            id: "regulator/checkout-guidance",
            title: "Checkout guidance",
            publisher: "Example regulator",
            url: "https://example.test/checkout-guidance",
            jurisdictions: ["US"],
            reviewedAt: "2026-07-22",
          },
        ],
        knownLimitations: ["Fixture analysis uses static markup only."],
      },
      evaluate(doc, ctx) {
        return doc
          .findAll((node) => node.tag === "button")
          .map((node) =>
            ctx.createFinding({
              evidence: [{ locator: node.locator, text: node.subtreeText }],
              description: "A governed button was found.",
              whyItMatters: "Governance fixtures prove public metadata authoring.",
              recommendation: "Use this as a copyable governed RulePack structure.",
            }),
          );
      },
    },
    {
      meta: {
        id: "example/deprecated-governance-rule",
        title: "Deprecated governance rule",
        category: "obstruction",
        defaultSeverity: "info",
        defaultConfidence: "low",
        defaultEnabled: true,
        tags: ["authoring-fixture"],
        version: "1.0.0",
        maturity: "deprecated",
        requiredCapabilities: ["structure", "text"],
        evidenceRequirements: ["presence"],
        deprecation: {
          since: "0.1.0",
          reason: "The main governance fixture rule is the maintained contract example.",
          removalTarget: "1.0.0",
          replacementRuleId: "example/governance-rule",
        },
      },
      evaluate() {
        return [];
      },
    },
  ],
};

export const scanHtmlInput = "<main><button>Buy now</button></main>";
export const expectedRuleIds = ["example/governance-rule"];
