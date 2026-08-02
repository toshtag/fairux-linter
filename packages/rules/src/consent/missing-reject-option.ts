import type { Finding, Rule, UiNode } from "@fairux/core";
import { reviewedGovernanceByRuleId } from "../generated/reviewed-governance.js";
import { staticTextAbsenceGovernance } from "../governance.js";
import {
  isControl,
  labelMatches,
  labelMatchesAffirmative,
  nearestContainer,
  within,
} from "../helpers.js";

export const missingRejectOption: Rule = {
  meta: {
    id: "consent/missing-reject-option",
    title: "Accept without a clear reject option",
    category: "consent",
    defaultSeverity: "medium",
    defaultConfidence: "medium",
    defaultEnabled: true,
    // Scoped to consent/marketing contexts so ordinary "agree & continue" flows don't trip it.
    appliesTo: ["consent", "marketing"],
    tags: ["consent"],
    // 1.1.0, with this rule's own code unchanged. 結構です joined the Japanese `reject` group, so the
    // rule stops firing on forms that offer it — a version exists to say when a rule's behaviour
    // changed, and this one's did. The major holds, so nothing downstream breaks.
    // 1.2.0: a refusal is no longer read as an accept. `I do not agree` matched the `accept` group,
    // and 同意 matched 「同意しません」, so a page whose only control refuses consent was reported as
    // offering an accept with no reject beside it (#183). This rule's own code is unchanged.
    // 1.3.0: いりません joined the Japanese `reject` group (#188), for the same reason 結構です did in
    // #182 — a form offering a decline was reported as offering none. This rule's own code is
    // unchanged.
    // 1.4.0: 受け取る now needs an object (#188). Bare, it made every receive-shaped control a
    // consent accept. This rule's own code is unchanged.
    version: "1.4.0",
    ...staticTextAbsenceGovernance,
    ...reviewedGovernanceByRuleId["consent/missing-reject-option"],
  },
  evaluate(doc, ctx): Finding[] {
    const isReject = (n: UiNode): boolean =>
      isControl(ctx, n) && labelMatches(ctx, ctx.semantics.getControlLabel(n), "reject");

    const accepts = doc
      .all()
      .filter(
        (n) =>
          isControl(ctx, n) &&
          labelMatchesAffirmative(ctx, ctx.semantics.getControlLabel(n), "accept"),
      );

    // An accept is "balanced" only when a reject lives in its *own* container — a reject buried
    // in a far-away footer does not count. (Falls back to the whole document for flat markup.)
    const unbalanced = accepts.filter((a) => !within(ctx, nearestContainer(ctx, a)).some(isReject));

    const accept = unbalanced[0];
    if (!accept) return [];

    return [
      ctx.createFinding({
        evidence: unbalanced.slice(0, 3).map((n) => ({
          locator: n.locator,
          text: ctx.semantics.getControlLabel(n),
          source: n.source,
        })),
        description:
          "An accept/agree control is present, but no clear reject, decline, or manage-preferences option was found nearby.",
        whyItMatters:
          "Without an equally available way to refuse, consent is not a free and informed choice.",
        recommendation:
          "Offer a clearly visible reject/decline (or manage preferences) option alongside accept.",
        fingerprintText: ctx.semantics.getControlLabel(accept),
      }),
    ];
  },
};
