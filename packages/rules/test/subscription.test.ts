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
  it("does not read a refusal as the CTA it refuses [negative]", () => {
    // The finding used to name the decline button as the call to action, with its own evidence
    // reading 「結構です、今は登録したくありません」 — a label saying the user does *not* want to
    // register (#183). English has the same exposure; it just had no corpus case naming it.
    for (const [lang, label] of [
      ["en", "Don't subscribe"],
      ["en", "Do not subscribe"],
      ["en", "I don't want to upgrade"],
      ["en", "No, I won't sign up"],
      ["ja", "結構です、今は登録したくありません"],
      ["ja", "登録しません"],
      ["ja", "購読しない"],
      ["ja", "アップグレードしない"],
    ] as const) {
      const report = run(
        `<html lang="${lang}"><body><main><p>${
          lang === "en" ? "Subscription billed monthly." : "定期購入。自動更新です。"
        }</p><button>${label}</button></main></body></html>`,
        allRules,
      );
      expect(ruleIds(report), label).not.toContain("subscription/cta-without-cancellation-context");
    }
  });

  it("keeps a CTA whose negation attaches to something else", () => {
    // The trap the guard has to survive. "Don't miss out" negates *missing out*, not subscribing,
    // and a guard that only looked for a negation anywhere in the label would silence a real CTA —
    // a false negative, which is the quieter and worse direction.
    for (const [lang, label] of [
      ["en", "Don't miss out — subscribe now"],
      ["en", "Don't wait, join now"],
      ["ja", "見逃さないよう登録する"],
    ] as const) {
      const report = run(
        `<html lang="${lang}"><body><main><p>${
          lang === "en" ? "Subscription billed monthly." : "定期購入。自動更新です。"
        }</p><button>${label}</button></main></body></html>`,
        allRules,
      );
      expect(ruleIds(report), label).toContain("subscription/cta-without-cancellation-context");
    }
  });
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

  it("does not flag a free newsletter signup [negative]", () => {
    // The false positive an adversarial corpus page found: `Subscribe to our newsletter` is one of
    // the most common controls on the web, and a mailing list has no plan to cancel. It used to fire
    // because the word `subscribe` alone put the page in the subscription context.
    const report = run(
      `<html><head><title>Weekly digest</title></head><body><h1>Weekly digest</h1>
       <p>One email each Friday.</p><form><input type="email"><button>Subscribe</button></form>
       </body></html>`,
      allRules,
    );
    expect(ruleIds(report)).not.toContain("subscription/cta-without-cancellation-context");
  });

  it("still flags a paid plan that says only Subscribe [en]", () => {
    // The half that had to survive: the money is what makes it a commitment, and the price puts the
    // page in `pricing` whether or not anything says `subscription`.
    const report = run(
      `<html><head><title>Plans</title></head><body><h1>Plans</h1><section>
       <p>$12 per month, billed monthly.</p><button>Subscribe</button></section></body></html>`,
      allRules,
    );
    expect(findingsFor(report, "subscription/cta-without-cancellation-context")).toHaveLength(1);
  });

  it("still flags a paid plan whose only signal is the word subscription [en]", () => {
    const report = run(
      `<html><head><title>Your subscription</title></head><body><h1>Your subscription</h1>
       <section><button>Subscribe</button></section></body></html>`,
      allRules,
    );
    expect(findingsFor(report, "subscription/cta-without-cancellation-context")).toHaveLength(1);
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
