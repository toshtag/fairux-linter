import { describe, expect, it } from "vitest";
import { allRules } from "../src/index.js";
import { findingsFor, ruleIds, run } from "./_util.js";

const RULE = "cancellation/missing-cancellation-link";

describe("cancellation/missing-cancellation-link", () => {
  it("flags an account page that manages a subscription with no cancel path [en]", () => {
    const report = run(
      `<html><body><h1>Account settings</h1>
        <p>Your subscription renews on May 1. Current plan: Pro.</p>
        <a href="/billing">Billing history</a></body></html>`,
      allRules,
    );
    expect(findingsFor(report, RULE)).toHaveLength(1);
  });

  it("flags a Japanese subscription-management page with no cancel path [ja]", () => {
    const report = run(
      `<html lang="ja"><body><h1>アカウント設定</h1>
        <p>ご利用中のプラン: プロ。次回の請求は5月1日です。</p>
        <a href="/history">請求履歴</a></body></html>`,
      allRules,
    );
    expect(findingsFor(report, RULE)).toHaveLength(1);
  });

  it("does not read two distant words as a cancel path [ja]", () => {
    // `/プラン.*変更/` matched 「ご利用中のプラン」 and 「パスワードを変更」 sixty characters apart, so
    // the rule concluded a cancel path existed and said nothing (#187). This group decides whether
    // something is *absent*, so a spurious match produces silence rather than a wrong finding — the
    // direction nobody notices.
    const report = run(
      `<html lang="ja"><body><main>
        <h1>アカウント設定</h1>
        <p>ご利用中のプラン: スタンダード(月額 1,280 円)</p>
        <p>次回の請求日: 2026年9月1日</p>
        <a href="/account/password">パスワードを変更</a>
      </main></body></html>`,
      allRules,
    );
    expect(findingsFor(report, RULE)).toHaveLength(1);
  });

  it("still reads an adjacent one [ja][negative]", () => {
    for (const label of [
      "プランを変更",
      "プランの変更",
      "契約を解除",
      "アカウントを削除",
      "解約",
    ]) {
      const report = run(
        `<html lang="ja"><body><main>
          <h1>アカウント設定</h1>
          <p>ご利用中のプラン: スタンダード</p>
          <a href="/x">${label}</a>
        </main></body></html>`,
        allRules,
      );
      expect(ruleIds(report), label).not.toContain(RULE);
    }
  });

  it("does not flag when a cancel link exists [negative]", () => {
    const report = run(
      `<html><body><h1>Account settings</h1>
        <p>Your subscription renews on May 1.</p>
        <a href="/cancel">Cancel subscription</a></body></html>`,
      allRules,
    );
    expect(ruleIds(report)).not.toContain(RULE);
  });

  it("does not flag a marketing/landing page with no active-subscription signal [negative]", () => {
    // pricing context, but no 'your subscription / current plan / next billing' text → stays quiet.
    const report = run(
      `<html><body><h1>Pricing</h1>
        <section><h2>Pro</h2><p>$12/month</p><a href="/sub">Subscribe</a></section></body></html>`,
      allRules,
    );
    expect(ruleIds(report)).not.toContain(RULE);
  });

  it("does not flag a page with no subscription/account context at all [negative]", () => {
    // A plain blog article: appliesTo (subscription/account/pricing/checkout) never matches → quiet.
    const report = run(
      `<html><body><article><h1>Our blog</h1>
        <p>We shipped a new feature today.</p></article></body></html>`,
      allRules,
    );
    expect(ruleIds(report)).not.toContain(RULE);
  });
});
