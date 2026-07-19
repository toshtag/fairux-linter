export const rulePack = {
  meta: {
    id: "example/dictionary-pack",
    version: "0.1.0",
    engineApiVersion: "1",
    title: "Dictionary authoring fixture",
    status: "stable",
  },
  dictionary: {
    en: {
      returnPolicy: [/return policy/i, /refund/i],
    },
    "ja-JP": {
      returnPolicy: [/返品/, /返金/],
    },
  },
  rules: [
    {
      meta: {
        id: "example/dictionary-return-policy",
        title: "Dictionary return policy",
        category: "obstruction",
        defaultSeverity: "info",
        defaultConfidence: "low",
        defaultEnabled: true,
        tags: ["authoring-fixture"],
        version: "1.0.0",
      },
      evaluate(doc, ctx) {
        const dictionary = ctx.getDictionary();
        if (!ctx.text.hasAny(doc.root.subtreeText, dictionary.returnPolicy ?? [])) return [];
        return [
          ctx.createFinding({
            evidence: [{ locator: doc.root.locator, text: doc.root.subtreeText }],
            description: "Return-policy dictionary text was found in the scanned content.",
            whyItMatters: "Dictionaries let RulePacks share locale-scoped phrase groups.",
            recommendation: "Keep dictionary regular expressions deterministic and stateless.",
          }),
        ];
      },
    },
  ],
};

export const scanHtmlInput = "<main><a href='/returns'>Return policy</a></main>";
export const expectedRuleIds = ["example/dictionary-return-policy"];
