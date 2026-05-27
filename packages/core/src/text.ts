/**
 * Text normalization — the single definition relied on by adapters, matchers, and fingerprints.
 *
 * Contract: Unicode NFKC → lowercase → whitespace-collapse → trim.
 * NFKC folds compatibility forms so JA/full-width variants compare equal:
 *   "０円" → "0円", "￥" → "¥", "税　込" → "税 込" (ideographic space → space).
 *
 * Note: the `/g` flag below is on a *literal recreated per call* and used with `.replace`,
 * so it is stateless — unrelated to the "no /g/y in reusable dictionary patterns" rule.
 */
export function normalizeText(text: string): string {
  return text.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
}
