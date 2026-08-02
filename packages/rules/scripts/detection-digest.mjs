/**
 * A digest of what the built-in rules actually match with.
 *
 * The review-approval fingerprint hashes the review *records* — prose, sources, evidence, and the
 * `ruleVersion` each record declares. It does not hash the rules. So an author who edits a matching
 * pattern and leaves the version alone passes every governance check: the record still matches the
 * declared version, the fingerprint is unchanged, and a baseline that covered different
 * behaviour keeps validating.
 *
 * That was measured rather than suspected. Widening one dictionary pattern without touching a version
 * passed `rules:reviews:check`, `rules:catalog:check`,
 * `eval:corpus:check`, and the full test suite — 3086 tests, all green, with a stable rule detecting
 * something nobody approved.
 *
 * This digest is what closes that. It covers the two surfaces a detection change goes through:
 *
 * - the **dictionary**, where every phrase a rule matches on is declared;
 * - each rule's **execution metadata** — severity, confidence, enablement, page-context scoping, and
 *   the capabilities it requires — which decide when a rule runs and what its findings carry;
 * - the **page-context keywords**, which decide what a rule's `appliesTo` resolves against. Scoping
 *   was in the digest from the first version and the table it points at was not, so a rule could be
 *   silenced everywhere, or made to fire everywhere, without moving the hash. Same hole, one level
 *   down.
 *
 * It is computed from the **built** package, not from source, for the same reason the API inventory
 * is: a comment, a rename, or a reformat must not make the baseline stale, and a pattern that reaches
 * the runtime must.
 *
 * - the **behaviour** of every rule over a frozen set of probe pages, which is what reaches a rule's
 *   `evaluate` body. Hashing the function source would catch a guard change and would also
 *   make the baseline stale on a comment edit; hashing what the rules *do* has neither downside. See
 *   `behaviour-probe.mjs`.
 *
 * ## What it does not cover
 *
 * A change that no probe can see. The probe set is thirty-three corpus pages, seven of them written
 * to sit just outside a rule, and a guard whose effect none of them exercises moves nothing here.
 * That is a smaller gap than hashing nothing at all, and it is the honest description of what a
 * behavioural check buys: coverage, not proof.
 */

import { createHash } from "node:crypto";

// 2: page-context keywords joined the payload. A rule's `appliesTo` was hashed from the first
//    version and the table it resolves against was not.
// 3: behaviour over a frozen probe set joined it, which is what finally reaches a rule's `evaluate`
//    body — the gap the first two versions named and did not close.
const SCHEMA_VERSION = 3;

/** Execution metadata: everything about a rule that decides when it runs and what it reports. */
function normalizeRuleMeta(meta) {
  return {
    id: meta.id,
    version: meta.version,
    category: meta.category,
    defaultSeverity: meta.defaultSeverity,
    defaultConfidence: meta.defaultConfidence,
    defaultEnabled: meta.defaultEnabled !== false,
    experimental: meta.experimental === true,
    maturity: meta.maturity,
    appliesTo: sorted(meta.appliesTo),
    appliesToMinConfidence: meta.appliesToMinConfidence ?? null,
    requiredCapabilities: sorted(meta.requiredCapabilities),
    optionalCapabilities: sorted(meta.optionalCapabilities),
    evidenceRequirements: sorted(meta.evidenceRequirements),
  };
}

/**
 * Every pattern, by locale and group, as the runtime holds it.
 *
 * `source` and `flags` rather than the object: two regular expressions are the same matcher when
 * those agree, and a `RegExp` does not serialize.
 */
function normalizeDictionary(dictionary) {
  const locales = {};
  for (const locale of Object.keys(dictionary ?? {}).sort(compare)) {
    const groups = {};
    for (const group of Object.keys(dictionary[locale] ?? {}).sort(compare)) {
      groups[group] = [...(dictionary[locale][group] ?? [])]
        .map((pattern) => `/${pattern.source}/${pattern.flags}`)
        // Sorted, because the order patterns are tried in does not change what the set matches.
        .sort(compare);
    }
    locales[locale] = groups;
  }
  return locales;
}

/** Context → phrases, sorted. Which phrase is checked first does not change what the table matches. */
function normalizeKeywordTable(table) {
  const contexts = {};
  for (const context of Object.keys(table ?? {}).sort(compare)) {
    contexts[context] = [...(table[context] ?? [])].sort(compare);
  }
  return contexts;
}

function sorted(values) {
  return values === undefined ? null : [...values].sort(compare);
}

function compare(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.keys(value)
    .sort(compare)
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`);
  return `{${entries.join(",")}}`;
}

export function buildDetectionDigestPayload({
  rules,
  journeyRules,
  dictionary,
  pageContextKeywords,
  behaviour,
}) {
  // Required, not optional. A caller that cannot measure behaviour would otherwise compute a digest
  // that is wrong rather than absent — and the failure would read as "detection changed", sending
  // somebody to re-approve a change that never happened. Refusing to answer is the honest failure.
  if (!behaviour) throw new Error("buildDetectionDigestPayload requires a measured behaviour map");
  return {
    detectionDigestSchemaVersion: SCHEMA_VERSION,
    pageContextKeywords: normalizeKeywordTable(pageContextKeywords),
    behaviour: normalizeBehaviour(behaviour),
    rules: [...(rules ?? [])]
      .map((rule) => normalizeRuleMeta(rule.meta))
      .sort((left, right) => compare(left.id, right.id)),
    journeyRules: [...(journeyRules ?? [])]
      .map((rule) => normalizeRuleMeta(rule.meta))
      .sort((left, right) => compare(left.id, right.id)),
    dictionary: normalizeDictionary(dictionary),
  };
}

/** Sorted by probe and by rule, so two runs over the same repository produce the same bytes. */
function normalizeBehaviour(behaviour) {
  return Object.fromEntries(
    Object.keys(behaviour)
      .sort(compare)
      .map((caseId) => [
        caseId,
        Object.fromEntries(
          Object.keys(behaviour[caseId] ?? {})
            .sort(compare)
            .map((ruleId) => [ruleId, behaviour[caseId][ruleId]]),
        ),
      ]),
  );
}

/** Lowercase hex SHA-256 over the canonical payload. */
export function computeDetectionDigest(input) {
  return createHash("sha256")
    .update(canonicalJson(buildDetectionDigestPayload(input)), "utf8")
    .digest("hex");
}
