/**
 * The Purchase Guard-style pack of the v1 registry consumer contract.
 *
 * Written against the RulePack contract `@fairux/sdk@0.1.0-beta.2` already publishes, and frozen
 * with the rest of `sdk-registry-consumer-v1`: this file must keep passing against every SDK that
 * honors the v1 contract, so it may never grow a field, capability, or API surface the published
 * beta does not accept. New surface is proven by a future `sdk-registry-consumer-v2` directory,
 * not by editing this one. It is deliberately independent of the release fixtures, which evolve
 * with the default branch ahead of the next publication.
 *
 * No network, TLS, domain, fraud, or security vocabulary: site signals travel beside a report at
 * the application layer, never inside FairUX findings. The official source below is a fixture-only
 * fictional URL, not a real authority.
 */
export const purchaseGuardRulePack = {
  meta: {
    id: "@purchase-guard/registry-consumer",
    version: "1.0.0",
    engineApiVersion: "1",
    title: "Purchase Guard registry consumer contract pack",
    status: "experimental",
  },
  taxonomy: {
    categories: [
      {
        id: "purchase-guard/return-policy",
        title: "Return policy",
        description: "Signals about return, refund, or exchange terms in purchase flows.",
      },
    ],
    pageContexts: [
      {
        id: "purchase-guard/checkout-form",
        title: "Checkout form",
        description: "Checkout forms where purchase terms should be visible before submission.",
      },
    ],
  },
  rules: [
    {
      meta: {
        id: "purchase-guard/missing-return-policy",
        title: "Missing return policy",
        category: "purchase-guard/return-policy",
        defaultSeverity: "low",
        defaultConfidence: "medium",
        defaultEnabled: true,
        tags: ["purchase-guard"],
        version: "1.0.0",
        maturity: "stable",
        requiredCapabilities: ["structure", "text"],
        evidenceRequirements: ["presence"],
        jurisdictions: ["JP"],
        officialSources: [
          {
            id: "regulator/registry-consumer-return-policy",
            title: "Return policy guidance",
            publisher: "Example regulator",
            url: "https://example.test/registry-consumer-return-policy",
            jurisdictions: ["JP"],
            reviewedAt: "2026-07-30",
          },
        ],
        knownLimitations: ["Fixture analysis uses static markup only."],
      },
      evaluate(doc, ctx) {
        const hasReturnPolicy = doc
          .all()
          .some((node) => /return policy|返品|返金/.test(node.normalizedText));
        if (hasReturnPolicy) return [];
        return [
          ctx.createFinding({
            evidence: [{ locator: doc.root.locator, text: doc.root.subtreeText }],
            description: "No return policy copy was found near the purchase flow.",
            whyItMatters: "Return terms are a consumer-protection signal.",
            recommendation: "Link to the return policy before checkout.",
          }),
        ];
      },
    },
    {
      meta: {
        id: "purchase-guard/checkout-form-return-policy",
        title: "Checkout form missing return policy",
        category: "purchase-guard/return-policy",
        defaultSeverity: "low",
        defaultConfidence: "medium",
        defaultEnabled: true,
        appliesTo: ["purchase-guard/checkout-form"],
        tags: ["purchase-guard"],
        version: "1.0.0",
        maturity: "stable",
        requiredCapabilities: ["structure", "text"],
        evidenceRequirements: ["presence"],
      },
      evaluate(doc, ctx) {
        const hasInput = doc.all().some((node) => node.tag === "input");
        const hasReturnPolicy = doc
          .all()
          .some((node) => /return policy|返品|返金/.test(node.normalizedText));
        if (!hasInput || hasReturnPolicy) return [];
        return [
          ctx.createFinding({
            evidence: [{ locator: doc.root.locator, text: doc.root.subtreeText }],
            description: "A checkout form was found without nearby return policy copy.",
            whyItMatters: "Return terms should be visible before a buyer submits checkout details.",
            recommendation: "Add a return policy link near the checkout form.",
          }),
        ];
      },
    },
  ],
};
