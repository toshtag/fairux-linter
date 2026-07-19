# Remediation examples

Before/after fixes per category. Remediations are **suggestions** grounded in a finding's
`recommendation` + `evidence`; the human applies them. Keep them minimal and concrete.

## consent/checked-checkbox

A pre-checked marketing opt-in.

```diff
- <label><input type="checkbox" checked> Email me product offers</label>
+ <label><input type="checkbox"> Email me product offers</label>
```
Leave consent/marketing boxes **unchecked** so opting in is an active choice.

## consent/missing-reject-option

Accept-only cookie banner.

```diff
  <div class="cookie-banner">
    <p>We use cookies for analytics.</p>
    <button>Accept all</button>
+   <button>Reject all</button>
+   <a href="/cookie-preferences">Manage preferences</a>
  </div>
```
Put the reject/manage control **in the same container** as accept (a footer link elsewhere
doesn't count) and give it comparable prominence.

## consent/bundled-consent

One checkbox covering several consents.

```diff
- <label><input type="checkbox">
-   I agree to the Terms, Privacy Policy, and marketing emails.</label>
+ <label><input type="checkbox"> I agree to the Terms and Privacy Policy.</label>
+ <label><input type="checkbox"> Send me marketing emails (optional).</label>
```
Split distinct consents into independent controls.

## subscription/free-trial-without-renewal-disclosure

A free-trial CTA with no nearby billing terms.

```diff
  <a class="btn" href="/signup">Start free trial</a>
+ <p class="terms">Free for 14 days, then $9/month. Cancel anytime before renewal.</p>
```
Place billing-start date, recurring price, and cancellation terms **next to** the CTA.

## subscription/cta-without-cancellation-context

```diff
  <a href="/subscribe">Subscribe</a>
  <p>$12/month</p>
+ <p>Cancel anytime — no cancellation fees.</p>
```

## scarcity/scarcity-phrase

Unverified urgency. Two valid fixes — remove it, or make it true and specific:

```diff
- <p>Only 2 left — hurry!</p>
+ <p>2 in stock</p>            <!-- only if backed by real, current inventory -->
```
Don't apply artificial countdowns/urgency that isn't backed by real data.

## hidden-cost/price-near-checkout-without-fee-disclosure

```diff
  <p class="price">$49.00</p>
+ <p class="fees">Incl. tax. Shipping $5.00. Total $54.00.</p>
  <button>Place order</button>
```
Disclose tax/shipping/fees (or the all-in total) **next to the price**, not only in a footer link.

## obstruction/modal-without-close-action

```diff
- <div class="modal" role="dialog">
+ <div class="modal" role="dialog">
+   <button aria-label="Close" class="modal-close">×</button>
    <p>Wait! Add a warranty?</p>
    <button>Yes, add it</button>
  </div>
```
Provide a clearly labeled, reachable close control.
