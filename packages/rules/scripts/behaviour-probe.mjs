/**
 * What the built-in rules actually *do*, measured against a frozen set of pages.
 *
 * The detection digest covers what a rule declares and what it matches on — its metadata, the
 * dictionary, the page-context table. It does not cover a rule's `evaluate` body.
 * `obstruction/confirmshaming` requires an interactive control as well as a dictionary match, and
 * dropping that requirement would make it fire on body copy, change nothing in the digest, and leave
 * a maintainer approval valid.
 *
 * Hashing the function source would catch it and would also invalidate an approval on a comment edit
 * or a reformat — training everyone to re-approve without reading, which is the same failure one step
 * further on. Hashing *behaviour* has neither downside: a comment cannot move it, a loosened guard
 * can.
 *
 * ## Why the list is frozen here
 *
 * The probes are corpus pages, named one by one. Adding a corpus case is **not** a detection change
 * and must not invalidate an approval — so the digest reads this list and not the manifest. A page
 * joins the probe set by being added here, deliberately, which is itself a change to what an approval
 * covers.
 *
 * ## Why these pages
 *
 * Every labelled positive, so each rule's firing path is exercised. Every negative, because a rule
 * that starts firing where it should not is the failure this is most likely to catch. And the seven
 * adversarial pages, which are the ones written to sit just outside a rule — a probe that only makes
 * a rule fire cannot notice a guard being removed.
 */

import { createHash } from "node:crypto";

/**
 * The pages the behaviour digest reads, by corpus case id.
 *
 * Frozen deliberately. A case removed from the corpus makes this list fail loudly rather than
 * silently shrinking what an approval covers.
 */
export const BEHAVIOUR_PROBE_CASES = Object.freeze([
  "adversarial-balanced-consent-unusual-en",
  "adversarial-cancellation-named-differently-en",
  "adversarial-factual-deadline-en",
  "adversarial-factual-inventory-en",
  "adversarial-fee-disclosure-odd-wording-en",
  "adversarial-neutral-decline-iie-ja",
  "adversarial-neutral-decline-no-i-en",
  "cancellation-account-page-no-path-en",
  "clean-account-page-with-cancellation-en",
  "clean-checkout-with-fees-en",
  "clean-consent-banner-en",
  "clean-consent-banner-ja",
  "clean-free-trial-with-renewal-en",
  "clean-granular-consent-en",
  "clean-informational-page-en",
  "clean-informational-page-ja",
  "clean-modal-with-close-en",
  "clean-neutral-decline-en",
  "clean-stock-status-en",
  "clean-subscribe-cta-with-cancellation-en",
  "consent-accept-only-banner-en",
  "consent-accept-only-banner-ja",
  "consent-bundled-terms-and-marketing-en",
  "consent-pre-checked-marketing-en",
  "consent-pre-checked-marketing-ja",
  "hidden-cost-checkout-price-only-en",
  "obstruction-confirmshaming-decline-en",
  "obstruction-modal-without-close-en",
  "scarcity-countdown-timer-en",
  "scarcity-phrase-stock-pressure-en",
  "scarcity-phrase-stock-pressure-ja",
  "subscription-cta-no-cancellation-en",
  "subscription-free-trial-no-renewal-en",
]);

/**
 * Findings per rule per probe, as a plain object a canonical hash can read.
 *
 * Counts rather than full findings: a finding's id and fingerprint carry positions and text, so
 * hashing them would make an approval depend on a page's whitespace. What a guard change moves is
 * *whether* and *how often* a rule fires, which is what this records.
 *
 * `scanPage` takes a case id and returns that page's findings. Supplied by the caller so this stays
 * free of the filesystem and of any particular adapter.
 */
export function measureBehaviour(scanPage) {
  const behaviour = {};
  for (const caseId of BEHAVIOUR_PROBE_CASES) {
    const counts = {};
    for (const finding of scanPage(caseId)) {
      counts[finding.ruleId] = (counts[finding.ruleId] ?? 0) + 1;
    }
    // Sorted on the way in, so two runs over the same repository produce the same bytes.
    behaviour[caseId] = Object.fromEntries(
      Object.keys(counts)
        .sort()
        .map((ruleId) => [ruleId, counts[ruleId]]),
    );
  }
  return behaviour;
}

/** A short digest of the behaviour map, for reporting beside the full one. */
export function summariseBehaviour(behaviour) {
  const rules = new Set();
  let findings = 0;
  for (const counts of Object.values(behaviour)) {
    for (const [ruleId, count] of Object.entries(counts)) {
      rules.add(ruleId);
      findings += count;
    }
  }
  return {
    probes: Object.keys(behaviour).length,
    rulesObserved: [...rules].sort(),
    findings,
    sha256: createHash("sha256").update(JSON.stringify(behaviour), "utf8").digest("hex"),
  };
}
