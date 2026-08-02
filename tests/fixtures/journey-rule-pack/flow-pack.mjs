/**
 * A RulePack with a journey rule, for exercising `fairux scan-journey` and `fairux rules`.
 *
 * It lives in fixtures because no built-in journey rule exists: writing one is a rule change and
 * needs a maintainer review, and the questions about how a cross-step finding should be weighed are
 * open. The CLI surface should not wait for either — a command with nothing to run would be
 * untestable in exactly the part that matters.
 *
 * The rule looks for a commitment that changes between steps: a price shown on one page and a
 * different one shown later in the same flow. That is the shape a journey rule has and a document
 * rule cannot have, which is the property these tests need.
 */

const PRICE = /\$(\d+(?:\.\d{2})?)/;

export const flowPack = {
  meta: {
    id: "@fixtures/flow",
    version: "0.0.0-test.0",
    engineApiVersion: "1",
    title: "Journey fixture pack",
    status: "stable",
  },
  rules: [],
  journeyRules: [
    {
      meta: {
        id: "fixtures/price-changed-across-steps",
        title: "The price changed between steps",
        category: "hidden-cost",
        defaultSeverity: "high",
        defaultConfidence: "medium",
        defaultEnabled: true,
        tags: [],
        version: "1.0.0",
        maturity: "stable",
        requiredCapabilities: ["journey", "text"],
        evidenceRequirements: ["comparison", "sequence"],
      },
      evaluate(journey, ctx) {
        const seen = [];
        for (const step of journey.steps) {
          const match = PRICE.exec(step.doc.root.subtreeText);
          if (match) seen.push({ step, price: match[1] });
        }
        if (seen.length < 2) return [];
        const first = seen[0];
        const changed = seen.find((entry) => entry.price !== first.price);
        if (!changed) return [];

        return [
          ctx.createFinding({
            // Anchored to where a reader should look — the step that differs, not the first one.
            stepId: changed.step.id,
            evidence: [
              { stepId: first.step.id, text: `$${first.price}` },
              { stepId: changed.step.id, text: `$${changed.price}` },
            ],
            description: `The price shown was $${first.price} and later $${changed.price}.`,
            whyItMatters:
              "A commitment that changes between steps of one flow may surprise a user at the point of payment.",
            recommendation:
              "Show the same total at every step, or explain the difference where it changes.",
          }),
        ];
      },
    },
  ],
};

export default flowPack;
