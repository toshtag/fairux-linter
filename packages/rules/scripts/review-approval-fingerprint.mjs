import { createHash } from "node:crypto";

const SCHEMA_VERSION = 1;

/**
 * The SHA-256 the review baseline pins as `reviewContentSha256`.
 *
 * A digest and nothing else. It used to arrive wrapped in five counts of the same records —
 * rules, stable, experimental, uncovered scenarios, open exceptions — which no caller read:
 * `check-reviews.mjs` prints the summary `validateReviewFoundation` returns, and the published
 * counts come from `generate-rule-catalog.mjs`.
 */
export function computeReviewApprovalFingerprint(input) {
  return sha256(canonicalJson(buildReviewApprovalFingerprintPayload(input)));
}

function buildReviewApprovalFingerprintPayload(input) {
  const sourceCatalog = input.sourceCatalog;
  const reviewRecords = input.reviewRecords;
  return {
    fingerprintSchemaVersion: SCHEMA_VERSION,
    sourceCatalogSchemaVersion: sourceCatalog.schemaVersion,
    reviewRecordsSchemaVersion: reviewRecords.schemaVersion,
    reviewPolicy: sortObject(reviewRecords.reviewPolicy ?? {}),
    officialSources: [...(sourceCatalog.sources ?? [])]
      .sort((left, right) => compareCodePoint(left.id, right.id))
      .map(normalizeOfficialSource),
    rules: [...(reviewRecords.rules ?? [])]
      .sort((left, right) => compareCodePoint(left.ruleId, right.ruleId))
      .map(normalizeReviewRecord),
  };
}

function normalizeOfficialSource(source) {
  return sortObject(source);
}

// Approval-state metadata is the only content excluded from the fingerprint,
// because Stage B adds it on purpose after the maintainer approves the packet.
// Everything else, including preparation and source-review provenance, must
// change the hash so a post-approval edit cannot pass fingerprint comparison.
function stripApprovalOnlyMetadata(record) {
  const { status, approvedBy, approvedAt, ...content } = record;
  return sortObject(content);
}

function normalizeReviewRecord(rule) {
  return {
    ruleId: rule.ruleId,
    ruleVersion: rule.ruleVersion,
    maturity: rule.maturity,
    preparedBy: rule.preparedBy,
    preparedAt: rule.preparedAt,
    ruleJurisdictions: sortedStrings(rule.ruleJurisdictions),
    officialSourceReviews: [...(rule.officialSourceReviews ?? [])]
      .sort((left, right) => compareCodePoint(left.sourceId, right.sourceId))
      .map((sourceReview) => ({
        sourceId: sourceReview.sourceId,
        reviewedAt: sourceReview.reviewedAt,
        jurisdictions: sortedStrings(sourceReview.jurisdictions),
        supportKind: sourceReview.supportKind,
        sourceLocator: sourceReview.sourceLocator,
        mappingNote: sourceReview.mappingNote,
        limitations: sourceReview.limitations,
      })),
    corpusEvidence: {
      positive: normalizeEvidenceEntries(rule.corpusEvidence?.positive),
      negative: normalizeEvidenceEntries(rule.corpusEvidence?.negative),
      ambiguous: normalizeEvidenceEntries(rule.corpusEvidence?.ambiguous),
    },
    uncoveredScenarios: [...(rule.uncoveredScenarios ?? [])]
      .sort((left, right) => compareCodePoint(left.id, right.id))
      .map(sortObject),
    reviewNotes: sortObject(rule.reviewNotes ?? {}),
    reviewExceptions: [...(rule.reviewExceptions ?? [])]
      .sort((left, right) => compareCodePoint(left.id, right.id))
      .map(stripApprovalOnlyMetadata),
  };
}

function normalizeEvidenceEntries(entries) {
  return [...(entries ?? [])]
    .sort((left, right) => compareCodePoint(left.id, right.id))
    .map(sortObject);
}

function sortedStrings(values) {
  return [...(values ?? [])].sort(compareCodePoint);
}

function sortObject(value) {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(sortObject);
  const output = {};
  for (const key of Object.keys(value).sort(compareCodePoint)) {
    if (value[key] !== undefined) output[key] = sortObject(value[key]);
  }
  return output;
}

function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.keys(value)
    .sort(compareCodePoint)
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`);
  return `{${entries.join(",")}}`;
}

function compareCodePoint(left, right) {
  const leftPoints = Array.from(left);
  const rightPoints = Array.from(right);
  const length = Math.min(leftPoints.length, rightPoints.length);
  for (let index = 0; index < length; index += 1) {
    const leftPoint = leftPoints[index].codePointAt(0);
    const rightPoint = rightPoints[index].codePointAt(0);
    if (leftPoint !== rightPoint) return leftPoint - rightPoint;
  }
  return leftPoints.length - rightPoints.length;
}

function sha256(content) {
  return createHash("sha256").update(content, "utf8").digest("hex");
}
