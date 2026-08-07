/**
 * Whether a corpus case is a positive or a negative, derived from what it expects.
 *
 * A case with something in `expected` is a positive; a case with an empty `expected` is a negative.
 * The manifest used to carry both, which is one fact in two places.
 *
 * A module of its own so the evaluation, the calibration, and the manifest contract ask the same
 * question rather than each writing the ternary out. The generated artifacts still report a kind per
 * case — a column saying "positive" reads better than an `expected` array — derived on the way out.
 */

/**
 * @param {{expected?: readonly unknown[]}} entry  a case from `corpus/manifest.json`
 * @returns {"positive" | "negative"}
 */
export function caseKind(entry) {
  return (entry?.expected?.length ?? 0) > 0 ? "positive" : "negative";
}
