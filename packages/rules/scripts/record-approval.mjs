#!/usr/bin/env node
/**
 * Write a maintainer approval into the packet, from facts a workflow measured.
 *
 * Every value here is computed or read from the environment. **Nothing is typed by a person**: the
 * flow this replaced asked a maintainer to write a paragraph and then asked an agent to transcribe a
 * comment URL, an author, a UTC timestamp, a 64-character fingerprint, and a 64-character digest
 * into JSON by hand. Six values copied between two systems is six chances to copy one wrongly, and
 * the check that would catch it is the same check the copying exists to satisfy.
 *
 * What a maintainer does instead is approve a protected environment. GitHub records who and when;
 * this records what.
 *
 * Run with `--check` it writes nothing and reports whether the packet already agrees, which is what
 * the workflow uses to tell "already approved at this commit" from "needs approval".
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { computeDetectionDigest } from "./detection-digest.mjs";
import { computeReviewApprovalFingerprint } from "./review-approval-fingerprint.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const APPROVAL_PATH = join(ROOT, "packages/rules/reviews/maintainer-approval.json");
const REVIEWS_PATH = join(ROOT, "packages/rules/reviews/built-in-rule-reviews.json");
const SOURCES_PATH = join(ROOT, "packages/rules/reviews/official-sources.json");
const CORE_PATH = join(ROOT, "packages/core/dist/index.js");
const RULES_PATH = join(ROOT, "packages/rules/dist/index.js");

const APPROVAL_ENVIRONMENT = "rule-maintenance-approval";
const COMMIT_SHA = /^[0-9a-f]{40}$/u;

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

/**
 * Measure the repository as it stands.
 *
 * From the built packages, not the sources, for the same reason the digest is: what an approval
 * covers is what a scan would run.
 */
export async function measureApprovalFacts() {
  const core = await import(pathToFileURL(CORE_PATH).href);
  const rules = await import(pathToFileURL(RULES_PATH).href);
  const reviewRecords = readJson(REVIEWS_PATH);
  const fingerprint = computeReviewApprovalFingerprint({
    sourceCatalog: readJson(SOURCES_PATH),
    reviewRecords,
  });
  const detectionDigest = computeDetectionDigest({
    rules: rules.fairuxBuiltinRulePack.rules,
    journeyRules: rules.fairuxBuiltinRulePack.journeyRules,
    dictionary: rules.dictionary,
    pageContextKeywords: core.PAGE_CONTEXT_KEYWORDS,
  });

  const records = [...(reviewRecords.rules ?? [])];
  const byMaturity = (maturity) =>
    records
      .filter((record) => record.maturity === maturity)
      .map((record) => record.ruleId)
      .sort();

  return {
    reviewContentSha256: fingerprint.reviewContentSha256,
    detectionDigest,
    approvedStableRuleIds: byMaturity("stable"),
    reviewedExperimentalRuleIds: byMaturity("experimental"),
    // Sorted by id, so two runs over the same repository produce the same bytes.
    approvedRules: records
      .filter((record) => record.maturity === "stable")
      .map((record) => ({ ruleId: record.ruleId, ruleVersion: record.ruleVersion }))
      .sort((left, right) => (left.ruleId < right.ruleId ? -1 : 1)),
    acknowledgedUncoveredScenarioCount: fingerprint.uncoveredScenarioCount,
    openReviewExceptionCount: fingerprint.openExceptionCount,
    // Which records the approval has to move, and the reason this is worth reporting: a run that
    // finds none is a run nobody needed.
    preparedRuleIds: records
      .filter((record) => record.status === "prepared" && record.maturity === "stable")
      .map((record) => record.ruleId)
      .sort(),
  };
}

/** The packet as it would be written. Pure, so a test can read it without a filesystem. */
export function buildApprovalPacket(facts, approval) {
  return {
    schemaVersion: 1,
    type: "github-environment-review",
    approvalTargetCommit: approval.approvalTargetCommit,
    reviewContentSha256: facts.reviewContentSha256,
    detectionDigest: facts.detectionDigest,
    approvedBy: approval.approvedBy,
    approvedAt: approval.approvedAt,
    approvedStableRuleIds: facts.approvedStableRuleIds,
    reviewedExperimentalRuleIds: facts.reviewedExperimentalRuleIds,
    experimentalDisposition: "reviewed-retained-prepared-default-off",
    acknowledgedUncoveredScenarioCount: facts.acknowledgedUncoveredScenarioCount,
    openReviewExceptionCount: facts.openReviewExceptionCount,
    environment: APPROVAL_ENVIRONMENT,
    workflowRunUrl: approval.workflowRunUrl,
    approvedRules: facts.approvedRules,
  };
}

/**
 * Stamp every stable record with this approval's identity.
 *
 * **Every** one, not only the records that were `prepared`. An approval here covers the current
 * state of the whole stable set — that is what `approvedStableRuleIds` has always listed — and the
 * gate enforces it: `validateStableRecords` requires each record's approver and date to equal the
 * packet's. Stamping only the changed rule would leave the others carrying an older date and fail
 * the check the stamping exists to satisfy.
 *
 * Experimental records are untouched. Approving one is a different act with a different effect on
 * what runs by default, and it is not what a rule-change approval is being asked for.
 */
export function approveRecords(reviewRecords, approval) {
  const rules = (reviewRecords.rules ?? []).map((record) => {
    if (record.maturity !== "stable") return record;
    const { status: _status, approvedBy: _by, approvedAt: _at, ...rest } = record;
    return {
      ...rest,
      status: "maintainer-approved",
      approvedBy: approval.approvedBy,
      approvedAt: approval.approvedAt,
    };
  });
  return { ...reviewRecords, rules };
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function main() {
  const check = process.argv.includes("--check");
  const facts = await measureApprovalFacts();

  if (check) {
    const current = readJson(APPROVAL_PATH);
    const agrees =
      current.reviewContentSha256 === facts.reviewContentSha256 &&
      current.detectionDigest === facts.detectionDigest;
    process.stdout.write(`${JSON.stringify({ ...facts, agrees }, null, 2)}\n`);
    return;
  }

  const approvalTargetCommit = requireEnv("APPROVAL_TARGET_COMMIT");
  if (!COMMIT_SHA.test(approvalTargetCommit)) {
    throw new Error(`APPROVAL_TARGET_COMMIT must be a 40-character lowercase SHA`);
  }
  const approval = {
    approvalTargetCommit,
    approvedBy: requireEnv("APPROVED_BY"),
    // From the run, in UTC, to the day — the granularity every other date in this packet uses.
    approvedAt: requireEnv("APPROVED_AT"),
    workflowRunUrl: requireEnv("WORKFLOW_RUN_URL"),
  };

  writeFileSync(
    APPROVAL_PATH,
    `${JSON.stringify(buildApprovalPacket(facts, approval), null, 2)}\n`,
    "utf8",
  );
  writeFileSync(
    REVIEWS_PATH,
    `${JSON.stringify(approveRecords(readJson(REVIEWS_PATH), approval), null, 2)}\n`,
    "utf8",
  );
  process.stdout.write(
    `recorded approval by ${approval.approvedBy} at ${approval.approvedAt} for ${facts.approvedRules.length} stable rules\n`,
  );
}

const thisFilePath = fileURLToPath(import.meta.url);
if (process.argv[1] === thisFilePath) await main();
