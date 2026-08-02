import { PAGE_CONTEXT_KEYWORDS } from "@fairux/core";
import { describe, expect, it } from "vitest";
import {
  buildDetectionDigestPayload,
  computeDetectionDigest,
} from "../scripts/detection-digest.mjs";
import { dictionary, fairuxBuiltinRulePack } from "../src/index.js";

/** The English group every mutation below starts from. Asserted non-empty by the first case. */
const confirmShame = dictionary.en?.confirmShame ?? [];
const en = dictionary.en ?? {};

const runtime = {
  rules: fairuxBuiltinRulePack.rules,
  ...(fairuxBuiltinRulePack.journeyRules
    ? { journeyRules: fairuxBuiltinRulePack.journeyRules }
    : {}),
  dictionary,
  pageContextKeywords: PAGE_CONTEXT_KEYWORDS,
};

function digest(over: Partial<typeof runtime> = {}): string {
  return computeDetectionDigest({ ...runtime, ...over });
}

function withPattern(group: string, pattern: RegExp) {
  return {
    ...dictionary,
    en: { ...en, [group]: [...(en[group] ?? []), pattern] },
  };
}

/**
 * The check that was not fail-closed, and the mutations that proved it.
 *
 * Widening one dictionary pattern without touching a `ruleVersion` used to pass
 * `rules:reviews:check`, `rules:reviews:check:approved`, `rules:catalog:check`, `eval:corpus:check`,
 * and the whole test suite — 3086 tests green, with a stable rule detecting something nobody
 * approved. Every mutation below is that failure in a different spelling.
 */
describe("the detection digest", () => {
  it("covers the built-in rules and the dictionary, and finds both non-empty", () => {
    // Without this, every mutation below could be comparing two hashes of nothing.
    const payload = buildDetectionDigestPayload(runtime) as {
      rules: { id: string }[];
      dictionary: Record<string, Record<string, string[]>>;
      pageContextKeywords: Record<string, string[]>;
    };
    expect(payload.rules.length).toBe(fairuxBuiltinRulePack.rules.length);
    expect(payload.rules.length).toBeGreaterThan(10);
    expect(Object.keys(payload.dictionary).sort()).toEqual(["en", "ja"]);
    expect(payload.dictionary.en?.confirmShame?.length).toBeGreaterThan(0);
    expect(Object.keys(payload.pageContextKeywords).sort()).toEqual([
      "account-settings",
      "checkout",
      "consent",
      "marketing",
      "pricing",
      "subscription",
    ]);
  });

  it("is stable across runs and across the order patterns are declared in", () => {
    expect(digest()).toBe(digest());
    const reversed = {
      ...dictionary,
      en: { ...en, confirmShame: [...confirmShame].reverse() },
    };
    // The order a set of patterns is tried in does not change what the set matches.
    expect(digest({ dictionary: reversed })).toBe(digest());
  });

  it("changes when a pattern is added", () => {
    expect(digest({ dictionary: withPattern("confirmShame", /\bi don'?t need this\b/) })).not.toBe(
      digest(),
    );
  });

  it("changes when a pattern is removed", () => {
    const fewer = {
      ...dictionary,
      en: { ...en, confirmShame: confirmShame.slice(1) },
    };
    expect(digest({ dictionary: fewer })).not.toBe(digest());
  });

  it("changes when a pattern is widened in place, which is the case that got through", () => {
    const widened = {
      ...dictionary,
      en: {
        ...en,
        confirmShame: [/\bi don'?t (care|want to save|need this)\b/, ...confirmShame.slice(1)],
      },
    };
    expect(digest({ dictionary: widened })).not.toBe(digest());
  });

  it("changes when a pattern's flags change, not only its source", () => {
    const reflagged = {
      ...dictionary,
      en: {
        ...en,
        confirmShame: [new RegExp(confirmShame[0]?.source ?? "x", "i")],
      },
    };
    expect(digest({ dictionary: reflagged })).not.toBe(digest());
  });

  it("changes when a rule's page-context scoping changes", () => {
    // Not a pattern edit, and it decides whether a rule runs at all — so it belongs in the digest
    // for exactly the same reason.
    const rescoped = fairuxBuiltinRulePack.rules.map((rule, index) =>
      index === 0 ? { ...rule, meta: { ...rule.meta, appliesTo: ["checkout" as const] } } : rule,
    );
    expect(digest({ rules: rescoped as never })).not.toBe(digest());
  });

  it("changes when a rule's default severity, confidence, or enablement changes", () => {
    const shift = (over: Record<string, unknown>) =>
      digest({
        rules: fairuxBuiltinRulePack.rules.map((rule, index) =>
          index === 0 ? { ...rule, meta: { ...rule.meta, ...over } } : rule,
        ) as never,
      });
    expect(shift({ defaultSeverity: "high" })).not.toBe(digest());
    expect(shift({ defaultConfidence: "low" })).not.toBe(digest());
    expect(shift({ defaultEnabled: false })).not.toBe(digest());
  });

  it("changes when a rule's required capabilities change", () => {
    const regated = fairuxBuiltinRulePack.rules.map((rule, index) =>
      index === 0
        ? { ...rule, meta: { ...rule.meta, requiredCapabilities: ["structure" as const] } }
        : rule,
    );
    expect(digest({ rules: regated as never })).not.toBe(digest());
  });

  it("changes when a page-context keyword is added", () => {
    // A rule's `appliesTo` was in the digest from the first version and the table it resolves
    // against was not. Adding one phrase here can make a scoped rule fire on pages it never saw.
    const widened = {
      ...PAGE_CONTEXT_KEYWORDS,
      marketing: [...PAGE_CONTEXT_KEYWORDS.marketing, "join our list"],
    };
    expect(digest({ pageContextKeywords: widened })).not.toBe(digest());
  });

  it("changes when a page-context keyword is removed", () => {
    // The other direction, and the quieter one: a scoped rule that stops running reports nothing,
    // which reads exactly like a page with nothing wrong.
    const narrowed = {
      ...PAGE_CONTEXT_KEYWORDS,
      subscription: PAGE_CONTEXT_KEYWORDS.subscription.slice(1),
    };
    expect(digest({ pageContextKeywords: narrowed })).not.toBe(digest());
  });

  it("does not change when page-context keywords are reordered", () => {
    const reordered = {
      ...PAGE_CONTEXT_KEYWORDS,
      consent: [...PAGE_CONTEXT_KEYWORDS.consent].reverse(),
    };
    expect(digest({ pageContextKeywords: reordered })).toBe(digest());
  });

  it("does not change when a rule's prose does", () => {
    // Titles and tags are read by people, not by a scan. An approval invalidated by a typo fix would
    // train everyone to re-approve without reading, which is the failure one step further on.
    const retitled = fairuxBuiltinRulePack.rules.map((rule, index) =>
      index === 0
        ? { ...rule, meta: { ...rule.meta, title: `${rule.meta.title} `, tags: [] } }
        : rule,
    );
    expect(digest({ rules: retitled as never })).toBe(digest());
  });
});
