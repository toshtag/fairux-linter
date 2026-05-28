import { describe, expect, it } from "vitest";
import { allRules } from "../src/index.js";
import { ruleIds, run } from "./_util.js";

/**
 * Realistic-page corpus. The compliant pages are the important half: a well-built page must
 * stay quiet, so these are the false-positive guard. The dark-pattern pages (incl. Japanese)
 * confirm detection still fires on realistic markup, not just minimal fixtures.
 */

describe("corpus: compliant pages stay quiet (false-positive guard)", () => {
  it("cookie banner offering accept + reject + manage triggers no consent finding", () => {
    const ids = ruleIds(
      run(
        `<html><body>
          <div class="cookie-consent">
            <p>We use cookies for analytics. You can accept or reject.</p>
            <button type="button">Accept all</button>
            <button type="button">Reject all</button>
            <a href="/cookie-preferences">Manage preferences</a>
          </div>
        </body></html>`,
        allRules,
      ),
    );
    expect(ids).not.toContain("consent/missing-reject-option");
    expect(ids).not.toContain("consent/checked-checkbox");
    expect(ids).not.toContain("consent/bundled-consent");
  });

  it("checkout disclosing tax + shipping triggers no hidden-cost finding", () => {
    const ids = ruleIds(
      run(
        `<html><body><main>
          <section class="cart">
            <h1>Checkout</h1>
            <p>Wireless mouse</p>
            <p>Subtotal: $25.00</p>
            <p>Tax: $2.50</p>
            <p>Shipping: $5.00</p>
            <p>Total: $32.50</p>
          </section>
          <button type="button">Place order</button>
        </main></body></html>`,
        allRules,
      ),
    );
    expect(ids).not.toContain("hidden-cost/price-near-checkout-without-fee-disclosure");
  });

  it("free-trial CTA with renewal + cancellation disclosed stays quiet", () => {
    const ids = ruleIds(
      run(
        `<html><body>
          <section class="plan">
            <h2>Pro</h2>
            <a href="/signup">Start free trial</a>
            <p>Auto-renews at $9/month after 14 days. Cancel anytime.</p>
          </section>
        </body></html>`,
        allRules,
      ),
    );
    expect(ids).not.toContain("subscription/free-trial-without-renewal-disclosure");
  });

  it("pricing page whose subscribe CTA shows cancellation terms stays quiet", () => {
    const ids = ruleIds(
      run(
        `<html><body>
          <h1>Pricing</h1>
          <section class="tier">
            <h2>Pro</h2>
            <p>$12/month</p>
            <a href="/subscribe">Subscribe</a>
            <p>Cancel anytime — no cancellation fees.</p>
          </section>
        </body></html>`,
        allRules,
      ),
    );
    expect(ids).not.toContain("subscription/cta-without-cancellation-context");
  });
});

describe("corpus: Japanese dark-pattern pages are caught", () => {
  it("Japanese checkout: unqualified price + scarcity + no-close modal", () => {
    const ids = ruleIds(
      run(
        `<html lang="ja"><body>
          <h1>購入手続き</h1>
          <section class="cart">
            <p>ワイヤレスマウス</p>
            <p>500円</p>
            <p>残りわずか、お早めに！</p>
            <button type="button">注文を確定</button>
          </section>
          <div class="modal" role="dialog">
            <p>2年保証を追加しますか？</p>
            <button type="button">はい、追加する</button>
          </div>
        </body></html>`,
        allRules,
      ),
    );
    expect(ids).toContain("hidden-cost/price-near-checkout-without-fee-disclosure");
    expect(ids).toContain("scarcity/scarcity-phrase");
    expect(ids).toContain("obstruction/modal-without-close-action");
  });

  it("Japanese free-trial without renewal disclosure is flagged", () => {
    const ids = ruleIds(
      run(
        `<html lang="ja"><body>
          <section class="plan">
            <h2>プロプラン</h2>
            <a href="/signup">無料体験を始める</a>
          </section>
        </body></html>`,
        allRules,
      ),
    );
    expect(ids).toContain("subscription/free-trial-without-renewal-disclosure");
  });
});
