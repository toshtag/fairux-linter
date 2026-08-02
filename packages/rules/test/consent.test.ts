import { describe, expect, it } from "vitest";
import { allRules } from "../src/index.js";
import { findingsFor, ruleIds, run } from "./_util.js";

describe("consent/checked-checkbox", () => {
  it("flags a pre-checked marketing box (high) on a consent page [en]", () => {
    const report = run(
      `<html><body><h1>Cookie consent</h1>
       <label><input type="checkbox" checked> Email me marketing offers</label>
       </body></html>`,
      allRules,
    );
    const hits = findingsFor(report, "consent/checked-checkbox");
    expect(hits).toHaveLength(1);
    expect(hits[0]?.severity).toBe("high");
  });

  it("flags a pre-checked marketing box [ja]", () => {
    const report = run(
      `<html lang="ja"><body><h1>Cookie 同意</h1>
       <label><input type="checkbox" checked> マーケティングメールを受け取る</label>
       </body></html>`,
      allRules,
    );
    expect(findingsFor(report, "consent/checked-checkbox")).toHaveLength(1);
  });

  it("does not flag an unchecked box [negative]", () => {
    const report = run(
      `<html><body><h1>Cookie consent</h1>
       <label><input type="checkbox"> Email me marketing offers</label></body></html>`,
      allRules,
    );
    expect(ruleIds(report)).not.toContain("consent/checked-checkbox");
  });

  it("does not flag a benign pre-checked filter on a non-consent page [negative]", () => {
    const report = run(
      `<html><body><label><input type="checkbox" checked> Show in-stock only</label></body></html>`,
      allRules,
    );
    expect(ruleIds(report)).not.toContain("consent/checked-checkbox");
  });
});

describe("consent/missing-reject-option", () => {
  it("flags accept-only consent banners [en]", () => {
    const report = run(
      `<html><body><p>We use cookies to improve your experience.</p>
       <button>Accept all</button></body></html>`,
      allRules,
    );
    expect(findingsFor(report, "consent/missing-reject-option")).toHaveLength(1);
  });

  it("flags accept-only consent banners [ja]", () => {
    const report = run(
      `<html lang="ja"><body><p>クッキーを使用します。</p>
       <button>同意する</button></body></html>`,
      allRules,
    );
    expect(findingsFor(report, "consent/missing-reject-option")).toHaveLength(1);
  });

  it("does not flag when a reject option exists [negative]", () => {
    const report = run(
      `<html><body><p>We use cookies.</p>
       <button>Accept all</button><button>Reject all</button></body></html>`,
      allRules,
    );
    expect(ruleIds(report)).not.toContain("consent/missing-reject-option");
  });

  it("treats 結構です as a refusal [ja][negative]", () => {
    // Found by writing negative cases for #160: a form offering three ways to decline, all opening
    // with 結構です, was reported as offering none. 結構です is at least as common in Japanese UI as
    // いいえ, which was already covered.
    for (const label of [
      "結構です",
      "結構です、今回は不要です",
      "結構です、ニュースレターには興味はありません",
      "メールは結構です",
      "お知らせも結構です",
    ]) {
      const report = run(
        `<html lang="ja"><body><p>クッキーを使用します。</p>
         <button>同意する</button><button>${label}</button></body></html>`,
        allRules,
      );
      expect(ruleIds(report), label).not.toContain("consent/missing-reject-option");
    }
  });

  it("does not treat 〜で結構です as a refusal, because it is not one [ja]", () => {
    // The other reading, and the reason this is two patterns rather than the bare word. 結構です is
    // *no thank you* when it leads or is object-marked, and *that will do* after 〜で. Reading the
    // second as a refusal would silence a banner that offers no way to refuse — a false negative,
    // which is the quieter and worse direction.
    for (const label of [
      "この内容で結構です",
      "これで結構です",
      "それで結構です",
      "以上で結構です",
    ]) {
      const report = run(
        `<html lang="ja"><body><p>クッキーを使用します。</p>
         <button>同意する</button><button>${label}</button></body></html>`,
        allRules,
      );
      expect(findingsFor(report, "consent/missing-reject-option"), label).toHaveLength(1);
    }
  });

  it("flags accept when the only reject is in a far-away footer [local-context]", () => {
    const report = run(
      `<html><body>
        <div class="cookie-banner"><p>We use cookies.</p><button>Accept all</button></div>
        <footer><a href="/prefs">Manage preferences</a></footer>
      </body></html>`,
      allRules,
    );
    expect(findingsFor(report, "consent/missing-reject-option")).toHaveLength(1);
  });

  it("does not flag when reject lives in the same container [negative]", () => {
    const report = run(
      `<html><body>
        <div class="cookie-banner"><p>We use cookies.</p>
          <button>Accept all</button><a href="/prefs">Manage preferences</a></div>
      </body></html>`,
      allRules,
    );
    expect(ruleIds(report)).not.toContain("consent/missing-reject-option");
  });
});

describe("consent/bundled-consent", () => {
  it("flags a checkbox bundling multiple consents [en]", () => {
    const report = run(
      `<html><body><label><input type="checkbox">
       I agree to the Terms, Privacy Policy, and marketing emails.</label></body></html>`,
      allRules,
    );
    const hits = findingsFor(report, "consent/bundled-consent");
    expect(hits).toHaveLength(1);
    expect(hits[0]?.description).toMatch(/terms/);
  });

  it("flags a bundled consent checkbox [ja]", () => {
    const report = run(
      `<html lang="ja"><body><label><input type="checkbox">
       利用規約、プライバシーポリシー、およびマーケティングメールに同意します。</label></body></html>`,
      allRules,
    );
    expect(findingsFor(report, "consent/bundled-consent")).toHaveLength(1);
  });

  it("does not flag a single-topic consent [negative]", () => {
    const report = run(
      `<html><body><label><input type="checkbox">
       I agree to the Terms of Service.</label></body></html>`,
      allRules,
    );
    expect(ruleIds(report)).not.toContain("consent/bundled-consent");
  });
});
