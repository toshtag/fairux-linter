import { describe, expect, it } from "vitest";
import { allRules } from "../src/index.js";
import { findingsFor, ruleIds, run } from "./_util.js";

describe("scarcity/scarcity-phrase", () => {
  it("flags scarcity phrasing [en]", () => {
    const report = run(`<html><body><p>Only 2 left in stock!</p></body></html>`, allRules);
    expect(findingsFor(report, "scarcity/scarcity-phrase")).toHaveLength(1);
  });

  it("flags scarcity phrasing [ja]", () => {
    const report = run(
      `<html lang="ja"><body><p>残りわずか、お早めに。</p></body></html>`,
      allRules,
    );
    expect(findingsFor(report, "scarcity/scarcity-phrase")).toHaveLength(1);
  });

  it("does not flag neutral copy [negative]", () => {
    const report = run(`<html><body><p>Free shipping on all orders.</p></body></html>`, allRules);
    expect(ruleIds(report)).not.toContain("scarcity/scarcity-phrase");
  });
});

describe("hidden-cost/price-near-checkout-without-fee-disclosure", () => {
  it("flags a price on checkout with no fee disclosure [en]", () => {
    const report = run(
      `<html><body><h1>Checkout</h1><p>$49.00</p><button>Place order</button></body></html>`,
      allRules,
    );
    expect(
      findingsFor(report, "hidden-cost/price-near-checkout-without-fee-disclosure"),
    ).toHaveLength(1);
  });

  it("flags a price on checkout [ja]", () => {
    const report = run(
      `<html lang="ja"><body><h1>購入手続き</h1><p>500円</p><button>注文を確定</button></body></html>`,
      allRules,
    );
    expect(
      findingsFor(report, "hidden-cost/price-near-checkout-without-fee-disclosure"),
    ).toHaveLength(1);
  });

  it("does not flag when fees are disclosed [negative]", () => {
    const report = run(
      `<html><body><h1>Checkout</h1><p>$49.00 incl. tax. Free shipping.</p>
       <button>Place order</button></body></html>`,
      allRules,
    );
    expect(ruleIds(report)).not.toContain("hidden-cost/price-near-checkout-without-fee-disclosure");
  });

  it("flags a price when fee info is only in a far-away footer [local-context]", () => {
    const report = run(
      `<html><body><h1>Checkout</h1>
        <section class="cart"><p>$49.00</p><button>Place order</button></section>
        <footer><a href="/shipping">Shipping policy</a></footer>
      </body></html>`,
      allRules,
    );
    expect(
      findingsFor(report, "hidden-cost/price-near-checkout-without-fee-disclosure"),
    ).toHaveLength(1);
  });

  it("does not flag when fee info is in the same container [negative]", () => {
    const report = run(
      `<html><body><h1>Checkout</h1>
        <section class="cart"><p>$49.00</p><p>incl. tax. Free shipping.</p>
          <button>Place order</button></section>
      </body></html>`,
      allRules,
    );
    expect(ruleIds(report)).not.toContain("hidden-cost/price-near-checkout-without-fee-disclosure");
  });
});

describe("obstruction/modal-without-close-action", () => {
  it('counts 「あとで」 as a way out, like English "not now" [ja][negative]', () => {
    // English `close` has counted "not now" and "no thanks" since the first version; Japanese had
    // only 閉じる, とじる, × and ✕, so a modal offering 「あとで」 was reported as having no way out.
    // Found by writing a near-miss page for a rule that had no negative case at all.
    for (const label of ["あとで", "また後で", "結構です", "いりません"]) {
      const report = run(
        `<html lang="ja"><body><div class="modal" role="dialog"><h2>お知らせ</h2>
         <button type="submit">購読する</button><button type="button">${label}</button>
         </div></body></html>`,
        allRules,
      );
      expect(ruleIds(report), label).not.toContain("obstruction/modal-without-close-action");
    }
  });

  it("still flags a Japanese modal with no way out at all", () => {
    const report = run(
      `<html lang="ja"><body><div class="modal" role="dialog"><h2>お知らせ</h2>
       <button type="submit">購読する</button></div></body></html>`,
      allRules,
    );
    expect(findingsFor(report, "obstruction/modal-without-close-action")).toHaveLength(1);
  });
  it("flags a modal with no close control [en]", () => {
    const report = run(
      `<html><body><div class="modal"><h2>Wait!</h2><p>Subscribe now.</p></div></body></html>`,
      allRules,
    );
    const hits = findingsFor(report, "obstruction/modal-without-close-action");
    expect(hits).toHaveLength(1);
    expect(hits[0]?.severity).toBe("low");
  });

  it("does not flag a modal with an aria-label close button [negative]", () => {
    const report = run(
      `<html><body><div class="modal"><p>Subscribe.</p>
       <button aria-label="Close">×</button></div></body></html>`,
      allRules,
    );
    expect(ruleIds(report)).not.toContain("obstruction/modal-without-close-action");
  });

  /**
   * The parts of a modal are not modals (#206).
   *
   * Found by the third-party fixtures, not here: `modal-title`, `modal-body` and a BEM
   * `…__close` each contain a hint word, so each was treated as a modal of its own, looked for a
   * close control among its *own* descendants, found none, and fired. In one case the reported node
   * was the close button.
   */
  it("does not report the parts of a Bootstrap modal as modals [negative]", () => {
    const report = run(
      `<html><body><div class="modal" role="dialog"><div class="modal-dialog">
       <div class="modal-content"><div class="modal-header">
       <h5 class="modal-title">Modal title</h5>
       <button type="button" class="btn-close" aria-label="Close"></button></div>
       <div class="modal-body"><p>Body copy.</p></div></div></div></div></body></html>`,
      allRules,
    );
    expect(ruleIds(report)).not.toContain("obstruction/modal-without-close-action");
  });

  it("does not report the BEM children of a modal block as modals [negative]", () => {
    const report = run(
      `<html lang="ja"><body><dialog class="dads-modal-dialog" open>
       <div class="dads-modal-dialog__container">
       <div class="dads-modal-dialog__header"><h2 class="dads-modal-dialog__heading">タイトル</h2>
       <button type="button" class="dads-modal-dialog__close">閉じる</button></div>
       <div class="dads-modal-dialog__body">コンテンツ</div>
       <div class="dads-modal-dialog__actions"><button type="submit">送信</button></div>
       </div></dialog></body></html>`,
      allRules,
    );
    expect(ruleIds(report)).not.toContain("obstruction/modal-without-close-action");
  });

  it("still flags a namespaced modal block with no way out", () => {
    // The fix must not buy its silence by no longer recognising the container. `dads-modal-dialog`
    // is a modal; `dads-modal-dialog__close` is not.
    const report = run(
      `<html lang="ja"><body><div class="dads-modal-dialog">
       <div class="dads-modal-dialog__body">コンテンツ</div>
       <button type="submit">購読する</button></div></body></html>`,
      allRules,
    );
    expect(findingsFor(report, "obstruction/modal-without-close-action")).toHaveLength(1);
  });

  it("reports a modal wrapped in a modal once, on the outermost one", () => {
    const report = run(
      `<html><body><div class="modal-overlay" id="promo-overlay"><div class="modal" id="promo">
       <p>Subscribe now.</p><button type="submit">Subscribe</button>
       </div></div></body></html>`,
      allRules,
    );
    const hits = findingsFor(report, "obstruction/modal-without-close-action");
    expect(hits).toHaveLength(1);
    expect(hits[0]?.evidence[0]?.locator.value).toBe("#promo-overlay");
  });
});

describe("experimental rules", () => {
  const imbalanceHtml = `<html><body><p>We use cookies.</p>
    <button class="btn-primary">Accept</button>
    <a href="#" class="link">Reject</a></body></html>`;

  const weakCloseHtml = `<html><body><div class="modal"><p>Offer</p>
    <button class="close" style="opacity:0.2">×</button></div></body></html>`;

  it("are disabled by default", () => {
    const report = run(imbalanceHtml, allRules);
    expect(ruleIds(report)).not.toContain("consent/accept-reject-visual-imbalance");
    expect(run(weakCloseHtml, allRules).findings.map((f) => f.ruleId)).not.toContain(
      "obstruction/modal-close-visibility",
    );
  });

  it("accept-reject-visual-imbalance fires when explicitly enabled", () => {
    const report = run(imbalanceHtml, allRules, { includeExperimental: true });
    expect(findingsFor(report, "consent/accept-reject-visual-imbalance")).toHaveLength(1);
  });

  it("modal-close-visibility fires when explicitly enabled", () => {
    const report = run(weakCloseHtml, allRules, { includeExperimental: true });
    expect(findingsFor(report, "obstruction/modal-close-visibility")).toHaveLength(1);
  });

  /**
   * The half these rules did not have.
   *
   * Both had a page that makes them fire and none that should keep them quiet — and every defect
   * found in this rule set has come from the second kind. A rule that only ever gets shown the case
   * it was written for is a rule nobody has disagreed with.
   *
   * They are default-off, so the corpus evaluation runs with `includeExperimental: false` and its
   * numbers say nothing about them either way. That makes these the only place the quiet direction is
   * checked.
   */
  it("accept-reject-visual-imbalance stays quiet when both options look the same [negative]", () => {
    const balanced = `<html><body><div class="cookie-consent"><p>We use cookies.</p>
      <button class="btn-primary" style="font-weight: bold">Accept all</button>
      <button class="btn-primary" style="font-weight: bold">Reject all</button></div></body></html>`;
    const report = run(balanced, allRules, { includeExperimental: true });
    expect(ruleIds(report)).not.toContain("consent/accept-reject-visual-imbalance");
  });

  it("accept-reject-visual-imbalance needs a reject to compare against [negative]", () => {
    // An accept-only banner is the other rule's finding. Reporting imbalance against a control that
    // does not exist would be reporting the same page twice under two names.
    const acceptOnly = `<html><body><div class="cookie-consent"><p>We use cookies.</p>
      <button class="btn-primary" style="font-weight: bold">Accept all</button></div></body></html>`;
    const report = run(acceptOnly, allRules, { includeExperimental: true });
    expect(ruleIds(report)).not.toContain("consent/accept-reject-visual-imbalance");
  });

  it("modal-close-visibility stays quiet on an ordinary close control [negative]", () => {
    const ordinary = `<html><body><div class="modal"><p>Offer</p>
      <button class="close" aria-label="Close this dialog">×</button></div></body></html>`;
    const report = run(ordinary, allRules, { includeExperimental: true });
    expect(ruleIds(report)).not.toContain("obstruction/modal-close-visibility");
  });

  /**
   * The other caller of `isModalLike` (#206). It did not fire on the third-party pages, but it has
   * the same exposure: with each `modal-*` part counted as its own modal, a de-emphasized close
   * button that happens to sit inside one part is reported once per matching ancestor.
   */
  it("modal-close-visibility reports a weak close once, not once per modal part", () => {
    const nested = `<html><body><div class="modal"><div class="modal-dialog">
      <div class="modal-content"><div class="modal-header"><h5 class="modal-title">Offer</h5>
      <button class="btn-close" style="opacity:0.2" aria-label="Close">×</button></div>
      <div class="modal-body"><p>Offer</p></div></div></div></div></body></html>`;
    const report = run(nested, allRules, { includeExperimental: true });
    expect(findingsFor(report, "obstruction/modal-close-visibility")).toHaveLength(1);
  });

  it("modal-close-visibility leaves a modal with no close at all to the other rule [negative]", () => {
    const noClose = `<html><body><div class="modal"><p>Offer</p>
      <button type="submit">Subscribe</button></div></body></html>`;
    const report = run(noClose, allRules, { includeExperimental: true });
    expect(ruleIds(report)).not.toContain("obstruction/modal-close-visibility");
    // The absence is a finding, just not this one.
    expect(findingsFor(report, "obstruction/modal-without-close-action")).toHaveLength(1);
  });
});
