import { computeReviewApprovalFingerprint } from "./review-approval-fingerprint.mjs";

const SCHEMA_VERSION = 1;
const APPROVAL_PHASE = "P13";
const APPROVAL_TASK = "P13-T7";
const EXPERIMENTAL_DISPOSITION = "reviewed-retained-prepared-default-off";
const APPROVAL_REPOSITORY = "toshtag/fairux-linter";
const APPROVAL_PULL_NUMBER = 56;
// The maintainer and the Stage A commit whose review content the approval is
// against are both settled for P13. Pinning them here is what makes the
// checked-in evidence non-transferable: re-pointing it at another identity or
// another commit cannot be made self-consistent.
const APPROVAL_MAINTAINER = "toshtag";
const APPROVAL_TARGET_COMMIT = "69f6d53873863f70c03ce8837be88224017487d7";
const COMMIT_SHA = /^[0-9a-f]{40}$/u;
const CONTENT_SHA256 = /^[0-9a-f]{64}$/u;
const DATE = /^\d{4}-\d{2}-\d{2}$/u;
const COMMENT_ANCHOR = /^#issuecomment-\d+$/u;
/**
 * How the approval was obtained. Two forms, and the reader accepts both.
 *
 * `github-pr-comment` is the P13 approval: a maintainer wrote a comment, and a person transcribed
 * its URL, author, and date into this file by hand. It is kept because it is a historical fact and
 * rewriting history to fit a newer schema would be the opposite of what this packet is for.
 *
 * `github-environment-review` is what every approval after it uses. A protected environment gates a
 * workflow job; GitHub records who approved and when, and the workflow writes the packet. Nobody
 * transcribes a hash, a URL, or a timestamp — which is the point, because a step a person performs
 * by hand is a step a person performs wrongly.
 */
const EVIDENCE_TYPES = ["github-pr-comment", "github-environment-review"];

/** Present in both forms. */
const COMMON_EVIDENCE_KEYS = [
  "schemaVersion",
  "type",
  "approvalTargetCommit",
  "reviewContentSha256",
  // What the rules actually match with, at the moment of approval. The fingerprint hashes the
  // review records; this hashes the runtime, and without it an edited pattern under an unchanged
  // `ruleVersion` passes every check here.
  "detectionDigest",
  "approvedBy",
  "approvedAt",
  "approvedStableRuleIds",
  "reviewedExperimentalRuleIds",
  "experimentalDisposition",
  "acknowledgedUncoveredScenarioCount",
  "openReviewExceptionCount",
];

const EVIDENCE_KEYS_BY_TYPE = {
  "github-pr-comment": [...COMMON_EVIDENCE_KEYS, "phase", "task", "approvalCommentUrl"],
  "github-environment-review": [
    ...COMMON_EVIDENCE_KEYS,
    "environment",
    "workflowRunUrl",
    // Rule ids with the versions they carried when approved. The digest already fails on a changed
    // rule; this says in the packet *which* rules a reader is looking at, without opening a build.
    "approvedRules",
  ],
};

const APPROVAL_ENVIRONMENT = "rule-maintenance-approval";
const WORKFLOW_RUN_URL =
  /^https:\/\/github\.com\/(?<repository>[^/]+\/[^/]+)\/actions\/runs\/\d+$/u;

export function validateApprovalEvidence(input) {
  const errors = [];
  const evidence = input.approvalEvidence;
  const policy = {
    repository: input.repository ?? APPROVAL_REPOSITORY,
    pullNumber: input.pullNumber ?? APPROVAL_PULL_NUMBER,
    expectedApprover: input.expectedApprover ?? APPROVAL_MAINTAINER,
    expectedApprovalTargetCommit: input.expectedApprovalTargetCommit ?? APPROVAL_TARGET_COMMIT,
  };

  const type = evidence?.type;
  if (!EVIDENCE_TYPES.includes(type)) {
    // Before the key check, because which keys are legal depends on the answer.
    return failure([`approval evidence type must be one of ${EVIDENCE_TYPES.join(", ")}`]);
  }
  exactKeys(evidence, EVIDENCE_KEYS_BY_TYPE[type], "approval evidence", errors);
  if (errors.length > 0) return failure(errors);

  validateEvidenceIdentity(evidence, policy, errors);
  if (type === "github-pr-comment") {
    validateApprovalCommentUrl(evidence.approvalCommentUrl, policy, errors);
  } else {
    validateEnvironmentReview(evidence, policy, errors);
  }
  validateApprover(evidence.approvedBy, policy, errors);
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

  assertPattern(
    evidence.detectionDigest,
    CONTENT_SHA256,
    "approval evidence detectionDigest",
    "a 64-character lowercase SHA-256",
    errors,
  );
  const detectionDigest = input.detectionDigest;
  if (detectionDigest === undefined) {
    // Refused rather than skipped. A caller that cannot compute the digest cannot confirm the
    // approval covers what the rules do, and answering "approved" on that basis is the failure this
    // field exists to prevent.
    errors.push("approval evidence cannot be validated without the built rules' detection digest");
  } else if (evidence.detectionDigest !== detectionDigest) {
    errors.push(
      `approval evidence detectionDigest must equal the current detection digest ${detectionDigest}; ` +
        "a rule's matching behaviour changed, which needs a rule-version bump, an updated review record, and a fresh maintainer approval",
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
      type: evidence?.type ?? null,
      phase: APPROVAL_PHASE,
      task: APPROVAL_TASK,
      approvalTargetCommit: evidence.approvalTargetCommit,
      reviewContentSha256: fingerprint.reviewContentSha256,
      detectionDigest: input.detectionDigest ?? null,
      approvedBy: evidence.approvedBy,
      approvedAt: evidence.approvedAt,
      approvedStableRuleCount: countRuleIds(evidence.approvedStableRuleIds),
      reviewedExperimentalRuleCount: countRuleIds(evidence.reviewedExperimentalRuleIds),
      acknowledgedUncoveredScenarioCount: fingerprint.uncoveredScenarioCount,
      openReviewExceptionCount: fingerprint.openExceptionCount,
    },
  };
}

function validateEvidenceIdentity(evidence, policy, errors) {
  if (evidence.schemaVersion !== SCHEMA_VERSION) {
    errors.push(`approval evidence schemaVersion must be ${SCHEMA_VERSION}`);
  }
  if (evidence.type === "github-pr-comment") {
    if (evidence.phase !== APPROVAL_PHASE) {
      errors.push(`approval evidence phase must be ${APPROVAL_PHASE}`);
    }
    if (evidence.task !== APPROVAL_TASK) {
      errors.push(`approval evidence task must be ${APPROVAL_TASK}`);
    }
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
  // Pinned only for the P13 comment approval, which happened once at a known commit. An approval
  // flow that runs again cannot pin its target to a constant, so the environment form checks the
  // shape here and the *workflow* checks the value — it re-reads the pull request's head after the
  // environment gate and refuses to write anything if it moved while the approval was pending.
  if (
    evidence.type === "github-pr-comment" &&
    evidence.approvalTargetCommit !== policy.expectedApprovalTargetCommit
  ) {
    errors.push(
      `approval evidence approvalTargetCommit must equal the approved Stage A target ${policy.expectedApprovalTargetCommit}`,
    );
  }
  assertPattern(
    evidence.reviewContentSha256,
    CONTENT_SHA256,
    "approval evidence reviewContentSha256",
    "a 64-character lowercase SHA-256",
    errors,
  );
}

// Evidence and review records agreeing with each other proves nothing on its
// own: both are checked in, so both can be rewritten in the same commit. The
// approver has to match the maintainer the approval was actually obtained from.
function validateApprover(value, policy, errors) {
  const label = "approval evidence approvedBy";
  assertString(value, label, errors);
  if (typeof value !== "string") return;
  if (value !== policy.expectedApprover) {
    errors.push(`${label} must equal the expected maintainer ${policy.expectedApprover}`);
  }
}

/**
 * The environment form: which environment gated it, and which run wrote it.
 *
 * Neither can be proved offline — the same limitation the comment URL always had, and the reason
 * this check has never claimed to prove an approval happened. What it does prove is that the packet
 * names *this* repository's environment and *this* repository's run, so evidence lifted from
 * somewhere else cannot be made self-consistent.
 */
function validateEnvironmentReview(evidence, policy, errors) {
  if (evidence.environment !== APPROVAL_ENVIRONMENT) {
    errors.push(`approval evidence environment must be ${APPROVAL_ENVIRONMENT}`);
  }
  const match = WORKFLOW_RUN_URL.exec(String(evidence.workflowRunUrl ?? ""));
  if (!match) {
    errors.push(
      "approval evidence workflowRunUrl must be an https://github.com/<owner>/<repo>/actions/runs/<id> URL",
    );
  } else if (match.groups.repository !== policy.repository) {
    errors.push(
      `approval evidence workflowRunUrl must belong to ${policy.repository}, not ${match.groups.repository}`,
    );
  }
  validateApprovedRules(evidence.approvedRules, errors);
}

/**
 * The rule ids and versions the approval covers.
 *
 * The digest already fails when a rule changes, so this is not the gate — it is what lets a reader
 * see which rules and which versions were approved without building the package and hashing it.
 */
function validateApprovedRules(value, errors) {
  const label = "approval evidence approvedRules";
  if (!Array.isArray(value) || value.length === 0) {
    errors.push(`${label} must be a non-empty array`);
    return;
  }
  for (const entry of value) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      errors.push(`${label} entries must be objects`);
      return;
    }
    const keys = Object.keys(entry).sort();
    if (keys.length !== 2 || keys[0] !== "ruleId" || keys[1] !== "ruleVersion") {
      errors.push(`${label} entries must have exactly ruleId and ruleVersion`);
      return;
    }
    assertString(entry.ruleId, `${label}.ruleId`, errors);
    assertString(entry.ruleVersion, `${label}.ruleVersion`, errors);
  }
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
