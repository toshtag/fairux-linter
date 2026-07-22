export const rulePack = {
  meta: {
    id: "example/minimal-pack",
    version: "0.1.0",
    engineApiVersion: "1",
    title: "Minimal authoring fixture",
    status: "stable",
  },
  rules: [
    {
      meta: {
        id: "example/minimal-button",
        title: "Minimal button",
        category: "obstruction",
        defaultSeverity: "info",
        defaultConfidence: "low",
        defaultEnabled: true,
        tags: ["authoring-fixture"],
        version: "1.0.0",
        maturity: "stable",
        requiredCapabilities: ["structure", "text"],
        evidenceRequirements: ["presence"],
      },
      evaluate(doc, ctx) {
        return doc
          .findAll((node) => node.tag === "button")
          .map((node) =>
            ctx.createFinding({
              evidence: [{ locator: node.locator, text: node.subtreeText }],
              description: "A button was found in the scanned content.",
              whyItMatters: "Minimal fixtures prove the RulePack shape without external taxonomy.",
              recommendation: "Use this as the smallest copyable RulePack structure.",
            }),
          );
      },
    },
  ],
};

export const scanHtmlInput = "<main><button>Buy now</button></main>";
export const expectedRuleIds = ["example/minimal-button"];
