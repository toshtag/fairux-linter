import type { Finding, Rule } from "@fairux/core";
import { staticTextAbsenceGovernance } from "../governance.js";
import { dictGroup, isControl, labelMatches } from "../helpers.js";

const FTC = "https://www.ftc.gov/business-guidance/blog";

export const missingCancellationLink: Rule = {
  meta: {
    id: "cancellation/missing-cancellation-link",
    title: "No cancellation path on a subscription/account page",
    category: "cancellation",
    defaultSeverity: "medium",
    defaultConfidence: "low",
    defaultEnabled: true,
    // Only on pages that plausibly manage an existing subscription/account — never a marketing/
    // landing page. This (plus the active-subscription text gate below) is what keeps the rule
    // from the false positives that got it deferred from v0.
    appliesTo: ["subscription", "account-settings", "pricing", "checkout"],
    appliesToMinConfidence: "medium",
    tags: ["cancellation", "subscription"],
    version: "1.0.0",
    references: [FTC],
    ...staticTextAbsenceGovernance,
  },
  evaluate(doc, ctx): Finding[] {
    const pageText = doc.root.normalizedText;

    // Gate 1: the page must actually signal an ACTIVE subscription/account, not just commerce.
    if (!ctx.text.hasAny(pageText, dictGroup(ctx, "activeSubscription"))) return [];

    // Gate 2: no cancel/manage/unsubscribe control anywhere — by control label OR page text
    // (a footer "Cancel subscription" link counts; we only flag genuine absence).
    const cancelGroup = dictGroup(ctx, "cancelLink");
    const hasCancelControl = doc
      .all()
      .some(
        (n) =>
          isControl(ctx, n) && labelMatches(ctx, ctx.semantics.getControlLabel(n), "cancelLink"),
      );
    const hasCancelText = ctx.text.hasAny(pageText, cancelGroup);
    if (hasCancelControl || hasCancelText) return [];

    return [
      ctx.createFinding({
        evidence: [{ locator: doc.root.locator, source: doc.root.source }],
        description:
          "This page appears to manage an active subscription or account, but no cancellation, unsubscribe, or manage-subscription path was found.",
        whyItMatters:
          "If cancelling is harder to find than subscribing, users can be trapped in recurring charges.",
        recommendation:
          "Provide a clearly visible cancellation / manage-subscription link on subscription and account pages.",
        fingerprintText: "missing-cancellation-link",
      }),
    ];
  },
};
