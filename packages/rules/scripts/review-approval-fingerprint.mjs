import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SCHEMA_VERSION = 1;

export function computeReviewApprovalFingerprint(input) {
  const sourceCatalog = input.sourceCatalog;
  const reviewRecords = input.reviewRecords;
  const rules = [...(reviewRecords.rules ?? [])].sort((left, right) =>
    compareCodePoint(left.ruleId, right.ruleId),
  );
  const sources = [...(sourceCatalog.sources ?? [])].sort((left, right) =>
    compareCodePoint(left.id, right.id),
  );
  const payload = {
    schemaVersion: SCHEMA_VERSION,
    officialSources: sources.map(normalizeOfficialSource),
    rules: rules.map(normalizeReviewRecord),
  };
  const reviewContentSha256 = sha256(canonicalJson(payload));
  return {
    schemaVersion: SCHEMA_VERSION,
    ruleCount: rules.length,
    stableRuleCount: rules.filter((rule) => rule.maturity === "stable").length,
    experimentalRuleCount: rules.filter((rule) => rule.maturity === "experimental").length,
    uncoveredScenarioCount: rules.reduce(
      (count, rule) => count + (rule.uncoveredScenarios?.length ?? 0),
      0,
    ),
    openExceptionCount: rules.reduce(
      (count, rule) =>
        count +
        (rule.reviewExceptions ?? []).filter((exception) => exception.status === "open").length,
      0,
    ),
    reviewContentSha256,
  };
}

export function buildReviewApprovalFingerprintPayload(input) {
  const sourceCatalog = input.sourceCatalog;
  const reviewRecords = input.reviewRecords;
  return {
    schemaVersion: SCHEMA_VERSION,
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

function normalizeReviewRecord(rule) {
  return {
    ruleId: rule.ruleId,
    ruleVersion: rule.ruleVersion,
    maturity: rule.maturity,
    ruleJurisdictions: sortedStrings(rule.ruleJurisdictions),
    officialSourceReviews: [...(rule.officialSourceReviews ?? [])]
      .sort((left, right) => compareCodePoint(left.sourceId, right.sourceId))
      .map((sourceReview) => ({
        sourceId: sourceReview.sourceId,
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
      .map((exception) => {
        const { approvedAt, approvedBy, ...content } = exception;
        return sortObject(content);
      }),
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

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function main() {
  const rootDir = process.cwd();
  const result = computeReviewApprovalFingerprint({
    sourceCatalog: readJson(join(rootDir, "packages/rules/reviews/official-sources.json")),
    reviewRecords: readJson(join(rootDir, "packages/rules/reviews/built-in-rule-reviews.json")),
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

const thisFilePath = fileURLToPath(import.meta.url);
if (process.argv[1] === thisFilePath) main();
