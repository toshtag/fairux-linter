import type { Finding, Rule } from "@fairux/core";
import { dictGroup } from "../helpers.js";

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
  },
  evaluate(doc, ctx): Finding[] {
    const pageText = doc.root.normalizedText;
    if (!PRICE_PATTERNS.some((re) => re.test(pageText))) return [];
    if (ctx.text.hasAny(pageText, dictGroup(ctx, "fees"))) return [];

    const priceNode = doc
      .all()
      .find(
        (n) =>
          n.directText && PRICE_PATTERNS.some((re) => re.test(ctx.text.normalize(n.directText))),
      );
    const evidenceNode = priceNode ?? doc.root;

    return [
      ctx.createFinding({
        evidence: [
          {
            locator: evidenceNode.locator,
            text: priceNode?.directText ?? "",
            source: evidenceNode.source,
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
