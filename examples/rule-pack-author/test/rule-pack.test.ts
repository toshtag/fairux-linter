import { describe, expect, it } from "vitest";
import { composeRulePacks, fairuxBuiltinRulePack, RulePackError } from "@fairux/sdk";
import { scanHtml } from "@fairux/sdk/html";
import { purchaseGuardRulePack } from "../src/index.js";

describe("purchaseGuardRulePack", () => {
  it("composes with the built-in FairUX pack", () => {
    const composed = composeRulePacks([fairuxBuiltinRulePack, purchaseGuardRulePack], {
      includeExperimental: true,
    });

    expect(composed.rulePacks.map((pack) => pack.id)).toEqual([
      "@fairux/builtin",
      "@purchase-guard/jp-commerce",
    ]);
    expect(composed.taxonomy.categories.map((category) => category.id)).toContain(
      "purchase-guard/return-policy",
    );
  });

  it("reports a scoped missing-copy signal when the checkout context is supplied", () => {
    const report = scanHtml("<main><form><input name='email'><button>Buy now</button></form></main>", {
      includeExperimental: true,
      rulePacks: [fairuxBuiltinRulePack, purchaseGuardRulePack],
      pageContexts: [{ context: "purchase-guard/checkout-form", confidence: "high" }],
      now: () => new Date("2026-01-01T00:00:00Z"),
    });

    expect(report.findings.map((finding) => finding.ruleId)).toContain(
      "purchase-guard/missing-return-policy",
    );
  });

  it("fails fast when an external category is not declared", () => {
    expect(() =>
      composeRulePacks([
        {
          ...purchaseGuardRulePack,
          taxonomy: undefined,
        },
      ]),
    ).toThrow(RulePackError);
  });
});
