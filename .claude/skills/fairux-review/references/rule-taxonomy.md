# FairUX rule taxonomy

The 13 rules the linter ships, by category. **11 are enabled by default; 2 are experimental**
(off unless `--include-experimental`). Detection is the linter's job — this list is for
*explaining* a finding and for the non-authoritative manual-review fallback.

## consent

- **`consent/checked-checkbox`** — a checkbox is checked by default. Severity scales with what
  the user is pre-opted into: marketing/third-party → high; terms/privacy → medium; mild
  (age/remember-me) → low. Only fires when the box looks consent-related (by label or on a
  consent/marketing/subscription page).
- **`consent/missing-reject-option`** *(consent/marketing pages)* — an accept/agree control with
  no reject/decline/manage option **in the same container**. (A reject buried in a far footer
  doesn't count.)
- **`consent/bundled-consent`** — one checkbox bundles ≥2 distinct consents (e.g. terms +
  privacy + marketing). Denies granular choice. Visual-independent.

## subscription

- **`subscription/free-trial-without-renewal-disclosure`** (high) — a free-trial CTA with no
  auto-renew / billing-start disclosure in its surrounding section.
- **`subscription/cta-without-cancellation-context`** *(subscription/pricing/checkout pages)* — a
  subscribe CTA with no nearby cancellation terms.

## cancellation

- **`cancellation/missing-cancellation-link`** *(subscription/account/pricing/checkout pages)* — a
  page that signals an **active** subscription/account but has no cancel/unsubscribe/manage path
  anywhere. Triple-gated (context + active-subscription text + no cancel control) to avoid firing
  on marketing pages.

## scarcity

- **`scarcity/scarcity-phrase`** — scarcity/urgency phrasing ("only N left", "limited time",
  "残りわずか", "本日限定", "N people viewing"). Reported once at the owning node.
- **`scarcity/countdown-timer`** (low) — a countdown timer by structure (`data-countdown`/`timer`
  class) or text (`HH:MM:SS`, "ends in", "セール終了まで 残りN時間"). Ignores ordinary clock labels.

## hidden-cost

- **`hidden-cost/price-near-checkout-without-fee-disclosure`** *(checkout pages)* — a price shown
  with no tax/shipping/fee disclosure **in the price's own container**.

## obstruction

- **`obstruction/modal-without-close-action`** (low / medium-confidence) — a modal/dialog with no
  structurally detectable close control (button / link / `aria-label`). Low because static HTML
  can't observe JS/ESC/outside-click dismissal.
- **`obstruction/confirmshaming`** — a decline/opt-out control worded to guilt-trip the user
  ("No, I don't want to save money"; "いいえ、お得な情報はいりません"). Two-factor: must be a
  control AND match the confirmshame phrasing, so the same words in body copy are not flagged.

## Experimental (off by default — `--include-experimental`)

- **`consent/accept-reject-visual-imbalance`** (info) — accept looks visually stronger than
  reject, by class/inline-style heuristic. Static HTML can't see real layout, so it's a hint.
- **`obstruction/modal-close-visibility`** (info) — a modal close control looks de-emphasized
  (tiny/low-opacity/hidden-ish class).

## Categories not yet covered by a shipped rule

`privacy`, `accessibility`, `visual-asymmetry` exist in the schema but have few or no enabled
rules yet. Absence of a finding in these areas is **not** assurance — say so if asked.
