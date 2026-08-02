/**
 * The baseline a rule change has to move deliberately.
 *
 * Four mechanical values, all computed from the repository: a fingerprint over the review records, a
 * digest over what the rules detect, and each stable rule's declared version. Change what a rule
 * matches and the digest moves; change a review record and the fingerprint moves. Either one
 * mismatching means the change was made without saying so, and CI says which command fixes it.
 *
 * What is deliberately **not** here: who approved, when, from which comment, in which workflow run.
 * That machinery existed for one release and proved to guard availability rather than correctness —
 * a rule is right or wrong regardless of who clicked a button, and the values below are what tell
 * the difference.
 */

import { createHash } from "node:crypto";

export const BASELINE_SCHEMA_VERSION = 1;

const SHA256 = /^[0-9a-f]{64}$/u;
const SEMVER = /^\d+\.\d+\.\d+$/u;

/**
 * The baseline as the repository currently stands.
 *
 * Pure: the caller supplies the fingerprint and the digest it measured, so this stays testable
 * without a build and cannot compute half of an answer from a stale artifact.
 */
export function buildReviewBaseline({ reviewContentSha256, detectionDigest, reviewRecords }) {
  return {
    schemaVersion: BASELINE_SCHEMA_VERSION,
    reviewContentSha256,
    detectionDigest,
    rules: [...(reviewRecords.rules ?? [])]
      .filter((record) => record.maturity === "stable")
      .map((record) => ({ ruleId: record.ruleId, ruleVersion: record.ruleVersion }))
      .sort((left, right) => (left.ruleId < right.ruleId ? -1 : 1)),
  };
}

/** Whether the checked-in baseline still describes the repository. */
export function validateReviewBaseline({ baseline, current, runtimeRules }) {
  const errors = [];
  // A list, as `collectRuntimeRuleMetadata` returns it, so callers do not each build their own index.
  const runtimeById = new Map([...runtimeRules].map((rule) => [rule.id, rule]));

  if (baseline === null || typeof baseline !== "object" || Array.isArray(baseline)) {
    return { ok: false, errors: ["review baseline must be an object"], summary: {} };
  }
  if (baseline.schemaVersion !== BASELINE_SCHEMA_VERSION) {
    errors.push(
      `review baseline schemaVersion must be ${BASELINE_SCHEMA_VERSION}, found ${JSON.stringify(baseline.schemaVersion)}`,
    );
  }

  // Refuse to answer rather than answer wrongly: a malformed digest compared against a real one
  // reports "detection changed", which reads as a finding and is not one.
  for (const key of ["reviewContentSha256", "detectionDigest"]) {
    if (!SHA256.test(String(baseline[key] ?? ""))) {
      errors.push(`review baseline ${key} must be a lowercase SHA-256`);
    } else if (baseline[key] !== current[key]) {
      errors.push(
        key === "detectionDigest"
          ? `review baseline detectionDigest is ${baseline[key]}, but the rules now detect ${current[key]}. A rule whose matching changed needs a ruleVersion bump and an updated review record.`
          : `review baseline reviewContentSha256 is ${baseline[key]}, but the review records now hash to ${current[key]}.`,
      );
    }
  }

  const declared = new Map();
  for (const entry of baseline.rules ?? []) {
    if (typeof entry?.ruleId !== "string" || !SEMVER.test(String(entry?.ruleVersion ?? ""))) {
      errors.push(`review baseline rules entries need a ruleId and a semver ruleVersion`);
      continue;
    }
    declared.set(entry.ruleId, entry.ruleVersion);
  }

  // Against the built rules, not against the records: the records are what the fingerprint already
  // covers, and a baseline that only agreed with them would never notice the build disagreeing.
  for (const [ruleId, version] of declared) {
    const runtime = runtimeById.get(ruleId);
    if (runtime === undefined) {
      errors.push(`review baseline names ${ruleId}, which the rule pack does not export`);
    } else if (runtime.version !== version) {
      errors.push(
        `review baseline records ${ruleId} at ${version}, but the rule pack ships ${runtime.version}`,
      );
    }
  }
  for (const rule of runtimeById.values()) {
    if (rule.maturity === "stable" && !declared.has(rule.id)) {
      errors.push(`stable rule ${rule.id} is missing from the review baseline`);
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    summary: {
      schemaVersion: baseline.schemaVersion,
      reviewContentSha256: baseline.reviewContentSha256,
      detectionDigest: baseline.detectionDigest,
      ruleCount: declared.size,
    },
  };
}

/** Stable bytes for the same repository state, so a regenerated baseline diffs only when it should. */
export function serializeReviewBaseline(baseline) {
  return `${JSON.stringify(baseline, null, 2)}\n`;
}

/** A short digest of the baseline, for reporting beside the full values. */
export function summariseReviewBaseline(baseline) {
  return createHash("sha256").update(serializeReviewBaseline(baseline), "utf8").digest("hex");
}
