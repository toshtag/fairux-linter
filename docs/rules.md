# Built-in rule catalog

This catalog is generated from `packages/rules/reviews/official-sources.json` and
`packages/rules/reviews/built-in-rule-reviews.json`. It records FairUX review
provenance for UX risk signals; it is not a legal-compliance catalog.

- Rule pack: `@fairux/builtin@0.1.0`
- Rules: 13 (11 stable, 2 experimental)
- Reviews: 13 prepared, 0 maintainer-approved
- Official source identities: 11

Machine-readable catalog: [`docs/generated/rule-catalog.json`](generated/rule-catalog.json).

## Rules

| Rule | Maturity | Jurisdictions | Runtime sources | Review | Corpus | Gaps |
| --- | --- | --- | --- | --- | --- | --- |
| `cancellation/missing-cancellation-link` | stable | US | 2 | prepared | 1 positive / 1 negative / 0 ambiguous | 1 uncovered / 0 exceptions |
| `consent/accept-reject-visual-imbalance` | experimental | EEA, EU, GB, US | 3 | prepared | 1 positive / 1 negative / 0 ambiguous | 1 uncovered / 0 exceptions |
| `consent/bundled-consent` | stable | EEA, EU, GB | 2 | prepared | 1 positive / 1 negative / 0 ambiguous | 1 uncovered / 0 exceptions |
| `consent/checked-checkbox` | stable | EEA, EU, US | 3 | prepared | 1 positive / 1 negative / 0 ambiguous | 1 uncovered / 0 exceptions |
| `consent/missing-reject-option` | stable | EEA, EU, GB, US | 3 | prepared | 1 positive / 1 negative / 0 ambiguous | 1 uncovered / 0 exceptions |
| `hidden-cost/price-near-checkout-without-fee-disclosure` | stable | US | 2 | prepared | 1 positive / 1 negative / 0 ambiguous | 1 uncovered / 0 exceptions |
| `obstruction/confirmshaming` | stable | US, global | 2 | prepared | 1 positive / 1 negative / 0 ambiguous | 1 uncovered / 0 exceptions |
| `obstruction/modal-close-visibility` | experimental | US, global | 2 | prepared | 1 positive / 1 negative / 0 ambiguous | 1 uncovered / 0 exceptions |
| `obstruction/modal-without-close-action` | stable | US, global | 2 | prepared | 1 positive / 1 negative / 0 ambiguous | 1 uncovered / 0 exceptions |
| `scarcity/countdown-timer` | stable | EU, US | 2 | prepared | 1 positive / 1 negative / 0 ambiguous | 1 uncovered / 0 exceptions |
| `scarcity/scarcity-phrase` | stable | EU, US, global | 3 | prepared | 1 positive / 1 negative / 0 ambiguous | 1 uncovered / 0 exceptions |
| `subscription/cta-without-cancellation-context` | stable | US | 2 | prepared | 1 positive / 1 negative / 0 ambiguous | 1 uncovered / 0 exceptions |
| `subscription/free-trial-without-renewal-disclosure` | stable | US | 2 | prepared | 1 positive / 1 negative / 0 ambiguous | 1 uncovered / 0 exceptions |

## Runtime source policy

Runtime `officialSources` include only source reviews whose source publication status is
`current` and whose support kind is `direct`, `contextual`, or `standard`. Historical,
vacated, and proposed records remain in the generated JSON catalog as review provenance.

## Source identities

- `eu/cjeu-planet49-cookie-consent` (current): Planet49 judgment on cookie consent and pre-ticked boxes - Court of Justice of the European Union
- `eu/edpb-guidelines-05-2020-consent` (current): Guidelines 05/2020 on consent under Regulation 2016/679 - European Data Protection Board
- `eu/ucpd-annex-limited-time-claims` (current): Unfair Commercial Practices Directive Annex I limited-time claims - European Union
- `global/oecd-dark-commercial-patterns` (current): Dark commercial patterns - Organisation for Economic Co-operation and Development
- `uk/ico-storage-access-consent-practice` (current): How do we manage consent in practice? - Information Commissioner's Office
- `us/ftc-dark-patterns-report` (current): Bringing Dark Patterns to Light - Federal Trade Commission
- `us/ftc-negative-option-1973-current-rule` (current): Rule Concerning the Use of Prenotification Negative Option Plans - Electronic Code of Federal Regulations
- `us/ftc-negative-option-2024-vacated-final-rule` (vacated): Negative Option Rule final rule amendments - Federal Trade Commission
- `us/ftc-negative-option-2026-anprm` (proposed): Negative Option Rule: Advance Notice of Proposed Rulemaking - Federal Trade Commission
- `us/ftc-unfair-deceptive-fees-faq` (current): The Rule on Unfair or Deceptive Fees: Frequently Asked Questions - Federal Trade Commission
- `w3c/wai-aria-modal-dialog-pattern` (current): Dialog (Modal) Pattern - World Wide Web Consortium Web Accessibility Initiative
