import type { Finding, Rule } from "@fairux/core";
import { staticTextAbsenceGovernance } from "../governance.js";
import { dictGroup, nearestContainer } from "../helpers.js";

const FTC = "https://www.ftc.gov/business-guidance/blog";

// Structural price detection (not language keywords): currency symbols or "<n>円" / "<n>.<nn>".
const PRICE_PATTERNS = [/[$€£¥]\s?\d/, /\b\d+\s?円/, /\b\d+\.\d{2}\b/];

export const priceNearCheckoutWithoutFeeDisclosure: Rule = {
  meta: {
    id: "hidden-cost/price-near-checkout-without-fee-disclosure",
    title: "Price shown without fee/tax disclosure",
    category: "hidden-cost",
    defaultSeverity: "medium",
    defaultConfidence: "medium",
    defaultEnabled: true,
    // Narrowed to checkout so it doesn't fire on marketing/pricing pages where fees differ.
    appliesTo: ["checkout"],
    tags: ["hidden-cost"],
    version: "1.0.0",
    references: [FTC],
    ...staticTextAbsenceGovernance,
  },
  evaluate(doc, ctx): Finding[] {
    const fees = dictGroup(ctx, "fees");
    const priceNodes = doc
      .all()
      .filter(
        (n) =>
          n.directText && PRICE_PATTERNS.some((re) => re.test(ctx.text.normalize(n.directText))),
      );
    if (priceNodes.length === 0) return [];

    // A price is disclosed only if tax/shipping/fee wording lives in its *own* container —
    // a "shipping policy" link in the footer must not excuse an unqualified price in the cart.
    const undisclosed = priceNodes.filter(
      (p) => !ctx.text.hasAny(nearestContainer(ctx, p).normalizedText, fees),
    );
    const priceNode = undisclosed[0];
    if (!priceNode) return [];

    return [
      ctx.createFinding({
        evidence: [
          {
            locator: priceNode.locator,
            text: priceNode.directText,
            source: priceNode.source,
          },
        ],
        description:
          "A price is shown on a checkout page, but no tax, shipping, or fee disclosure was found.",
        whyItMatters:
          "Users may not see the true total until late in the flow, making the displayed price misleading.",
        recommendation:
          "Disclose taxes, shipping, and fees (or the all-in total) next to the price.",
        fingerprintText: "price-without-fee-disclosure",
      }),
    ];
  },
};
