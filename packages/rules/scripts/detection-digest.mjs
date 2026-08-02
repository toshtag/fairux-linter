/**
 * A digest of what the built-in rules actually match with.
 *
 * The review-approval fingerprint hashes the review *records* — prose, sources, evidence, and the
 * `ruleVersion` each record declares. It does not hash the rules. So an author who edits a matching
 * pattern and leaves the version alone passes every governance check: the record still matches the
 * declared version, the fingerprint is unchanged, and a maintainer approval that covered different
 * behaviour keeps validating.
 *
 * That was measured rather than suspected. Widening one dictionary pattern without touching a version
 * passed `rules:reviews:check`, `rules:reviews:check:approved`, `rules:catalog:check`,
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
 * is: a comment, a rename, or a reformat must not invalidate an approval, and a pattern that reaches
 * the runtime must.
 *
 * ## What it does not cover
 *
 * A rule's `evaluate` body. `obstruction/confirmshaming` requires an interactive control as well as a
 * dictionary match, and changing that requirement changes detection without moving anything here.
 * Hashing function source would catch it and would also invalidate an approval on a comment edit,
 * which is a worse trade. The gap is real, it is narrower than the one this closes, and naming it is
 * the point — a check described as fail-closed and quietly not is how this whole problem started.
 */

import { createHash } from "node:crypto";

// 2: page-context keywords joined the payload. A rule's `appliesTo` was hashed from the first
// version and the table it resolves against was not.
const SCHEMA_VERSION = 2;

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
}) {
  return {
    detectionDigestSchemaVersion: SCHEMA_VERSION,
    pageContextKeywords: normalizeKeywordTable(pageContextKeywords),
    rules: [...(rules ?? [])]
      .map((rule) => normalizeRuleMeta(rule.meta))
      .sort((left, right) => compare(left.id, right.id)),
    journeyRules: [...(journeyRules ?? [])]
      .map((rule) => normalizeRuleMeta(rule.meta))
      .sort((left, right) => compare(left.id, right.id)),
    dictionary: normalizeDictionary(dictionary),
  };
}

/** Lowercase hex SHA-256 over the canonical payload. */
export function computeDetectionDigest(input) {
  return createHash("sha256")
    .update(canonicalJson(buildDetectionDigestPayload(input)), "utf8")
    .digest("hex");
}
