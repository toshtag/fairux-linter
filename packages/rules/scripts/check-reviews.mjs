#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { computeDetectionDigest } from "./detection-digest.mjs";
import { measureProbeBehaviour } from "./probe-runner.mjs";
import { computeReviewApprovalFingerprint } from "./review-approval-fingerprint.mjs";
import { validateReviewBaseline } from "./review-baseline.mjs";
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

const baselinePath = readFlagValue("--baseline");
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
});

const errors = [...result.errors];
const summary = { ...result.summary };

// Opt-in, so the ordinary gate stays usable while records are still being prepared. CI passes the
// flag, and from then on the checked-in baseline has to keep describing the repository.
if (baselinePath !== undefined) {
  let baseline;
  try {
    baseline = readJson(resolve(process.cwd(), baselinePath));
  } catch (error) {
    fail([`review baseline could not be read from ${baselinePath}: ${error.message}`]);
  }
  const result = validateReviewBaseline({
    baseline,
    runtimeRules,
    current: {
      reviewContentSha256: computeReviewApprovalFingerprint({ sourceCatalog, reviewRecords })
        .reviewContentSha256,
      // From the built package, so what is compared is what a scan would run.
      detectionDigest: computeDetectionDigest({
        rules: rulesModule.fairuxBuiltinRulePack.rules,
        journeyRules: rulesModule.fairuxBuiltinRulePack.journeyRules,
        dictionary: rulesModule.dictionary,
        pageContextKeywords: coreModule.PAGE_CONTEXT_KEYWORDS,
        behaviour: await measureProbeBehaviour(ROOT),
      }),
    },
  });
  if (result.errors.length > 0) {
    result.errors.push(
      "Run `pnpm rules:reviews:update` and include the regenerated baseline, the ruleVersion bump, and the updated review record in the pull request.",
    );
  }
  errors.push(...result.errors);
  summary.ok = summary.ok && result.ok;
  summary.baseline = result.summary;
}

if (errors.length > 0) {
  fail(errors);
} else {
  console.log(JSON.stringify(summary, null, 2));
}
