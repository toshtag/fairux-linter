/**
 * Whether a corpus case is a positive or a negative, derived from what it expects.
 *
 * The manifest carried a `kind` field beside `expected`, and the two said the same thing: a case
 * with something in `expected` is a positive, a case with an empty `expected` is a negative. The
 * README defines it that way in prose, and a contract test asserted the pair agreed — which is a
 * second copy of the answer plus an alarm that fires after somebody has written the wrong one.
 *
 * They agreed across all 57 cases when this was removed, and they agreed because nobody had made a
 * mistake, not because anything held them together. `expected` is the truth a case is written for;
 * `kind` was a label on it.
 *
 * Kept in a module of its own so `evaluate-corpus.mjs`, `calibrate-risk-index.mjs`, and the manifest
 * contract ask the same question rather than each writing the ternary out.
 *
 * The generated artifacts still report a kind per case. They are what a reader consults, and a
 * column that says "positive" is easier to read than an `expected` array — it is derived on the way
 * out rather than stored on the way in.
 */

/**
 * @param {{expected?: readonly unknown[]}} entry  a case from `corpus/manifest.json`
 * @returns {"positive" | "negative"}
 */
export function caseKind(entry) {
  return (entry?.expected?.length ?? 0) > 0 ? "positive" : "negative";
}
