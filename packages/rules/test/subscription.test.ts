import { describe, expect, it } from "vitest";
import { allRules } from "../src/index.js";
import { findingsFor, ruleIds, run } from "./_util.js";

describe("subscription/free-trial-without-renewal-disclosure", () => {
  it("flags a free-trial CTA with no nearby renewal disclosure [en]", () => {
    const report = run(
      `<html><body><section><h2>Pro plan</h2>
       <a href="/signup">Start free trial</a></section></body></html>`,
      allRules,
    );
    const hits = findingsFor(report, "subscription/free-trial-without-renewal-disclosure");
    expect(hits).toHaveLength(1);
    expect(hits[0]?.severity).toBe("high");
  });

  it("flags a free-trial CTA [ja]", () => {
    const report = run(
      `<html lang="ja"><body><section><h2>プロプラン</h2>
       <a href="/signup">無料体験を始める</a></section></body></html>`,
      allRules,
    );
    expect(findingsFor(report, "subscription/free-trial-without-renewal-disclosure")).toHaveLength(
      1,
    );
  });

  it("does not flag when renewal is disclosed nearby [negative]", () => {
    const report = run(
      `<html><body><section><a href="/signup">Start free trial</a>
       <p>Auto-renews at $9/month after 7 days. Cancel anytime.</p></section></body></html>`,
      allRules,
    );
    expect(ruleIds(report)).not.toContain("subscription/free-trial-without-renewal-disclosure");
  });
});

describe("subscription/cta-without-cancellation-context", () => {
  it("flags a subscribe CTA with no cancellation terms on a commerce page [en]", () => {
    const report = run(
      `<html><body><h1>Pricing plans</h1><section>
       <a href="/sub">Subscribe</a><p>$9/month</p></section></body></html>`,
      allRules,
    );
    expect(findingsFor(report, "subscription/cta-without-cancellation-context")).toHaveLength(1);
  });

  it("flags a subscribe CTA [ja]", () => {
    const report = run(
      `<html lang="ja"><body><h1>料金プラン</h1><section>
       <a href="/sub">購読する</a><p>月額900円</p></section></body></html>`,
      allRules,
    );
    expect(findingsFor(report, "subscription/cta-without-cancellation-context")).toHaveLength(1);
  });

  it("does not flag when cancellation terms are present [negative]", () => {
    const report = run(
      `<html><body><h1>Pricing plans</h1><section>
       <a href="/sub">Subscribe</a><p>$9/month. Cancel anytime.</p></section></body></html>`,
      allRules,
    );
    expect(ruleIds(report)).not.toContain("subscription/cta-without-cancellation-context");
  });

  it("does not fire outside commerce contexts [negative]", () => {
    const report = run(
      `<html><body><article><p>Read our blog.</p>
       <a href="/news">Sign up</a> for updates.</article></body></html>`,
      allRules,
    );
    expect(ruleIds(report)).not.toContain("subscription/cta-without-cancellation-context");
  });
});
