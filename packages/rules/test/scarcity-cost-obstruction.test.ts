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
});

describe("obstruction/modal-without-close-action", () => {
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
});
