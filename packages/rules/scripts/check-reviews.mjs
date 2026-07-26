#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { validateApprovalEvidence } from "./review-approval-validation.mjs";
import { collectRuntimeRuleMetadata, validateReviewFoundation } from "./review-validation.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const SOURCES_PATH = join(ROOT, "packages/rules/reviews/official-sources.json");
const REVIEWS_PATH = join(ROOT, "packages/rules/reviews/built-in-rule-reviews.json");
const CORE_PATH = join(ROOT, "packages/core/dist/index.js");
const BUILT_RULES_PATH = join(ROOT, "packages/rules/dist/index.js");

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function fail(errors) {
  console.error(JSON.stringify({ ok: false, errors }, null, 2));
  process.exit(1);
}

function readFlagValue(flag) {
  const index = process.argv.indexOf(flag);
  if (index === -1) return undefined;
  const value = process.argv[index + 1];
  if (value === undefined || value.startsWith("--")) fail([`${flag} requires a file path`]);
  return value;
}

const requireApprovedStable = process.argv.includes("--require-approved-stable");
const approvalEvidencePath = readFlagValue("--approval-evidence");
const coreModule = await import(pathToFileURL(CORE_PATH).href);
const rulesModule = await import(pathToFileURL(BUILT_RULES_PATH).href);
const sourceCatalog = readJson(SOURCES_PATH);
const reviewRecords = readJson(REVIEWS_PATH);
const runtimeRules = collectRuntimeRuleMetadata(rulesModule.fairuxBuiltinRulePack.rules);
const result = validateReviewFoundation({
  sourceCatalog,
  reviewRecords,
  runtimeRules,
  isBuiltinJurisdictionId: coreModule.isBuiltinJurisdictionId,
  isSemver: coreModule.isSemver,
  rootDir: ROOT,
  requireApprovedStable,
});

const errors = [...result.errors];
const summary = { ...result.summary };

// The evidence check is opt-in so the ordinary gate stays usable while a phase
// is still preparing records. Once a phase is closed out, CI passes the flag
// and the checked-in evidence has to keep agreeing with the packet.
if (approvalEvidencePath !== undefined) {
  let approvalEvidence;
  try {
    approvalEvidence = readJson(resolve(process.cwd(), approvalEvidencePath));
  } catch (error) {
    fail([`approval evidence could not be read from ${approvalEvidencePath}: ${error.message}`]);
  }
  const approval = validateApprovalEvidence({
    approvalEvidence,
    sourceCatalog,
    reviewRecords,
    runtimeRules,
  });
  errors.push(...approval.errors);
  summary.ok = summary.ok && approval.ok;
  summary.approval = approval.summary;
}

if (errors.length > 0) {
  fail(errors);
} else {
  console.log(JSON.stringify(summary, null, 2));
}
