import { PAGE_CONTEXT_KEYWORDS } from "@fairux/core";
import { describe, expect, it } from "vitest";
import { BEHAVIOUR_PROBE_CASES, measureBehaviour } from "../scripts/behaviour-probe.mjs";
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
  // A stand-in, so the cases below vary one half at a time. The real measurement is what
  // `rules:reviews:check:approved` computes; what these test is that each half moves the digest.
  behaviour: { "clean-page": { "a/b": 1 } } as Record<string, Record<string, number>>,
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

/**
 * The half of a rule the metadata and the dictionary cannot see.
 *
 * `obstruction/confirmshaming` requires an interactive control **and** a dictionary match. Dropping
 * the control requirement makes it fire on body copy, changes no pattern, no version, no capability
 * and no keyword — and until behaviour joined the digest, left a maintainer approval valid.
 */
describe("the behaviour half of the digest", () => {
  const behaviour = runtime.behaviour;

  it("moves when a rule fires where it did not", () => {
    const widened = { "clean-page": { "a/b": 1, "c/d": 1 } };
    expect(digest({ behaviour })).not.toBe(digest({ behaviour: widened }));
  });

  it("moves when a rule stops firing where it did", () => {
    // The quieter direction, and the one a findings list cannot distinguish from a clean page.
    expect(digest({ behaviour })).not.toBe(digest({ behaviour: { "clean-page": {} } }));
  });

  it("moves when a rule fires a different number of times", () => {
    const twice = { "clean-page": { "a/b": 2 } };
    expect(digest({ behaviour })).not.toBe(digest({ behaviour: twice }));
  });

  it("names its probes rather than reading the corpus manifest", () => {
    // Adding a corpus case is not a detection change and must not invalidate an approval. A page
    // joins the probe set by being named here, which is itself a change to what an approval covers.
    expect(BEHAVIOUR_PROBE_CASES.length).toBeGreaterThan(20);
    expect(new Set(BEHAVIOUR_PROBE_CASES).size).toBe(BEHAVIOUR_PROBE_CASES.length);
    expect([...BEHAVIOUR_PROBE_CASES]).toEqual([...BEHAVIOUR_PROBE_CASES].sort());
    // Including the pages written to sit just outside a rule — a probe that only makes a rule fire
    // cannot notice a guard being removed.
    expect(BEHAVIOUR_PROBE_CASES.filter((id) => id.startsWith("adversarial-")).length).toBe(7);
  });

  it("counts findings per rule, and not their ids or positions", () => {
    // Hashing a finding's id or fingerprint would make an approval depend on a page's whitespace.
    const measured = measureBehaviour(() => [
      { ruleId: "a/b", id: "a/b#0" },
      { ruleId: "a/b", id: "a/b#1" },
      { ruleId: "c/d", id: "c/d#0" },
    ]);
    const first = BEHAVIOUR_PROBE_CASES[0] as string;
    expect(measured[first]).toEqual({ "a/b": 2, "c/d": 1 });
  });
});
