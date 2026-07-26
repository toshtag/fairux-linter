import { computeReviewApprovalFingerprint } from "./review-approval-fingerprint.mjs";

const SCHEMA_VERSION = 1;
const APPROVAL_PHASE = "P13";
const APPROVAL_TASK = "P13-T7";
const EXPERIMENTAL_DISPOSITION = "reviewed-retained-prepared-default-off";
const APPROVAL_REPOSITORY = "toshtag/fairux-linter";
const APPROVAL_PULL_NUMBER = 56;
const COMMIT_SHA = /^[0-9a-f]{40}$/u;
const CONTENT_SHA256 = /^[0-9a-f]{64}$/u;
const DATE = /^\d{4}-\d{2}-\d{2}$/u;
const COMMENT_ANCHOR = /^#issuecomment-\d+$/u;
const EVIDENCE_KEYS = [
  "schemaVersion",
  "phase",
  "task",
  "approvalTargetCommit",
  "reviewContentSha256",
  "approvalCommentUrl",
  "approvedBy",
  "approvedAt",
  "approvedStableRuleIds",
  "reviewedExperimentalRuleIds",
  "experimentalDisposition",
  "acknowledgedUncoveredScenarioCount",
  "openReviewExceptionCount",
];

export function validateApprovalEvidence(input) {
  const errors = [];
  const evidence = input.approvalEvidence;
  const policy = {
    repository: input.repository ?? APPROVAL_REPOSITORY,
    pullNumber: input.pullNumber ?? APPROVAL_PULL_NUMBER,
  };

  exactKeys(evidence, EVIDENCE_KEYS, "approval evidence", errors);
  if (errors.length > 0) return failure(errors);

  validateEvidenceIdentity(evidence, errors);
  validateApprovalCommentUrl(evidence.approvalCommentUrl, policy, errors);
  assertString(evidence.approvedBy, "approval evidence approvedBy", errors);
  assertDate(evidence.approvedAt, "approval evidence approvedAt", errors);

  const fingerprint = computeReviewApprovalFingerprint({
    sourceCatalog: input.sourceCatalog,
    reviewRecords: input.reviewRecords,
  });
  if (evidence.reviewContentSha256 !== fingerprint.reviewContentSha256) {
    errors.push(
      `approval evidence reviewContentSha256 must equal the current substantive fingerprint ${fingerprint.reviewContentSha256}`,
    );
  }

  const records = [...(input.reviewRecords?.rules ?? [])];
  validateApprovedRuleIdLists(evidence, records, errors);
  validateStableRecords(evidence, records, errors);
  validateExperimentalRecords(records, input.runtimeRules ?? [], errors);
  assertCount(
    evidence.acknowledgedUncoveredScenarioCount,
    fingerprint.uncoveredScenarioCount,
    "approval evidence acknowledgedUncoveredScenarioCount",
    errors,
  );
  assertCount(
    evidence.openReviewExceptionCount,
    fingerprint.openExceptionCount,
    "approval evidence openReviewExceptionCount",
    errors,
  );

  return {
    ok: errors.length === 0,
    errors,
    summary: {
      ok: errors.length === 0,
      phase: APPROVAL_PHASE,
      task: APPROVAL_TASK,
      approvalTargetCommit: evidence.approvalTargetCommit,
      reviewContentSha256: fingerprint.reviewContentSha256,
      approvedBy: evidence.approvedBy,
      approvedAt: evidence.approvedAt,
      approvedStableRuleCount: countRuleIds(evidence.approvedStableRuleIds),
      reviewedExperimentalRuleCount: countRuleIds(evidence.reviewedExperimentalRuleIds),
      acknowledgedUncoveredScenarioCount: fingerprint.uncoveredScenarioCount,
      openReviewExceptionCount: fingerprint.openExceptionCount,
    },
  };
}

function validateEvidenceIdentity(evidence, errors) {
  if (evidence.schemaVersion !== SCHEMA_VERSION) {
    errors.push(`approval evidence schemaVersion must be ${SCHEMA_VERSION}`);
  }
  if (evidence.phase !== APPROVAL_PHASE) {
    errors.push(`approval evidence phase must be ${APPROVAL_PHASE}`);
  }
  if (evidence.task !== APPROVAL_TASK) {
    errors.push(`approval evidence task must be ${APPROVAL_TASK}`);
  }
  if (evidence.experimentalDisposition !== EXPERIMENTAL_DISPOSITION) {
    errors.push(`approval evidence experimentalDisposition must be ${EXPERIMENTAL_DISPOSITION}`);
  }
  assertPattern(
    evidence.approvalTargetCommit,
    COMMIT_SHA,
    "approval evidence approvalTargetCommit",
    "a 40-character lowercase commit SHA",
    errors,
  );
  assertPattern(
    evidence.reviewContentSha256,
    CONTENT_SHA256,
    "approval evidence reviewContentSha256",
    "a 64-character lowercase SHA-256",
    errors,
  );
}

// The approval event lives in the pull request the maintainer approved, so the
// URL is pinned to that repository and pull request. GitHub serves the same
// comment under both the `pull` and `issues` paths; both canonical forms are
// accepted, no other host, scheme, path, or query is.
function validateApprovalCommentUrl(value, policy, errors) {
  const label = "approval evidence approvalCommentUrl";
  assertString(value, label, errors);
  if (typeof value !== "string") return;
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    errors.push(`${label} must be a valid URL`);
    return;
  }
  if (parsed.protocol !== "https:") errors.push(`${label} must use https`);
  if (parsed.host !== "github.com") errors.push(`${label} must be hosted on github.com`);
  if (parsed.username || parsed.password) errors.push(`${label} must not contain credentials`);
  if (parsed.search) errors.push(`${label} must not contain a query string`);
  if (!COMMENT_ANCHOR.test(parsed.hash)) {
    errors.push(`${label} must reference an #issuecomment-<digits> anchor`);
  }
  const allowedPaths = new Set([
    `/${policy.repository}/pull/${policy.pullNumber}`,
    `/${policy.repository}/issues/${policy.pullNumber}`,
  ]);
  if (!allowedPaths.has(parsed.pathname)) {
    errors.push(`${label} must point at ${policy.repository} pull request ${policy.pullNumber}`);
  }
  if (parsed.href !== value) errors.push(`${label} must be canonical URL serialization`);
}

function validateApprovedRuleIdLists(evidence, records, errors) {
  assertRuleIdList(
    evidence.approvedStableRuleIds,
    ruleIdsByMaturity(records, "stable"),
    "approval evidence approvedStableRuleIds",
    errors,
  );
  assertRuleIdList(
    evidence.reviewedExperimentalRuleIds,
    ruleIdsByMaturity(records, "experimental"),
    "approval evidence reviewedExperimentalRuleIds",
    errors,
  );
}

function validateStableRecords(evidence, records, errors) {
  for (const record of records) {
    if (record.maturity !== "stable") continue;
    const label = `review ${record.ruleId}`;
    if (record.status !== "maintainer-approved") {
      errors.push(`${label} must be maintainer-approved under the approval evidence`);
      continue;
    }
    if (record.approvedBy !== evidence.approvedBy) {
      errors.push(`${label}.approvedBy must equal the approval evidence approvedBy`);
    }
    if (record.approvedAt !== evidence.approvedAt) {
      errors.push(`${label}.approvedAt must equal the approval evidence approvedAt`);
    }
  }
}

function validateExperimentalRecords(records, runtimeRules, errors) {
  const runtimeById = new Map(runtimeRules.map((rule) => [rule.id, rule]));
  for (const record of records) {
    if (record.maturity !== "experimental") continue;
    const label = `review ${record.ruleId}`;
    if (record.status !== "prepared") {
      errors.push(`${label} must remain prepared under the approval evidence`);
    }
    if ("approvedBy" in record || "approvedAt" in record) {
      errors.push(`${label} must not contain approval fields`);
    }
    const runtime = runtimeById.get(record.ruleId);
    if (runtime === undefined) {
      errors.push(`${label} has no matching runtime rule`);
      continue;
    }
    if (!runtime.experimental || runtime.defaultEnabled) {
      errors.push(`${label} must remain experimental and default-off at runtime`);
    }
  }
}

function ruleIdsByMaturity(records, maturity) {
  return records
    .filter((record) => record.maturity === maturity)
    .map((record) => record.ruleId)
    .sort(compareCodePoint);
}

function assertRuleIdList(value, expected, label, errors) {
  if (!Array.isArray(value) || value.length === 0) {
    errors.push(`${label} must be a non-empty array`);
    return;
  }
  const seen = new Set();
  for (const ruleId of value) {
    assertString(ruleId, `${label}[]`, errors);
    if (seen.has(ruleId)) errors.push(`${label} contains duplicate ${ruleId}`);
    seen.add(ruleId);
  }
  const sorted = [...value].sort(compareCodePoint);
  if (join(value) !== join(sorted)) {
    errors.push(`${label} must be sorted in canonical code-point order`);
    return;
  }
  if (join(value) !== join(expected)) {
    errors.push(`${label} must exactly equal the current rule ids [${expected.join(", ")}]`);
  }
}

function assertCount(value, expected, label, errors) {
  if (!Number.isInteger(value) || value < 0) {
    errors.push(`${label} must be a non-negative integer`);
    return;
  }
  if (value !== expected) errors.push(`${label} must equal the current count ${expected}`);
}

function countRuleIds(value) {
  return Array.isArray(value) ? value.length : 0;
}

function exactKeys(value, allowed, label, errors) {
  if (!isRecord(value)) {
    errors.push(`${label} must be an object`);
    return;
  }
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) errors.push(`${label} contains unknown field ${key}`);
  }
  for (const key of allowed) {
    if (!(key in value)) errors.push(`${label} missing required field ${key}`);
  }
}

function assertString(value, label, errors) {
  if (typeof value !== "string" || value.trim() === "") {
    errors.push(`${label} must be a non-empty string`);
    return;
  }
  if (value.trim() !== value)
    errors.push(`${label} must not contain leading or trailing whitespace`);
}

function assertPattern(value, pattern, label, expectation, errors) {
  assertString(value, label, errors);
  if (typeof value === "string" && !pattern.test(value))
    errors.push(`${label} must be ${expectation}`);
}

function assertDate(value, label, errors) {
  assertString(value, label, errors);
  if (typeof value !== "string" || !DATE.test(value)) {
    errors.push(`${label} must be YYYY-MM-DD`);
    return;
  }
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    errors.push(`${label} must be a valid calendar date`);
  }
}

function failure(errors) {
  return { ok: false, errors, summary: { ok: false } };
}

function join(values) {
  return values.join("\u0000");
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function compareCodePoint(left, right) {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}
