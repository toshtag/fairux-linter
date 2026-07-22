#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { collectRuntimeRuleMetadata, validateReviewFoundation } from "./review-validation.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const SOURCES_PATH = join(ROOT, "packages/rules/reviews/official-sources.json");
const REVIEWS_PATH = join(ROOT, "packages/rules/reviews/built-in-rule-reviews.json");
const BUILT_RULES_PATH = join(ROOT, "packages/rules/dist/index.js");

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

const requireApprovedStable = process.argv.includes("--require-approved-stable");
const rulesModule = await import(pathToFileURL(BUILT_RULES_PATH).href);
const result = validateReviewFoundation({
  sourceCatalog: readJson(SOURCES_PATH),
  reviewRecords: readJson(REVIEWS_PATH),
  runtimeRules: collectRuntimeRuleMetadata(rulesModule.fairuxBuiltinRulePack.rules),
  rootDir: ROOT,
  requireApprovedStable,
});

if (!result.ok) {
  console.error(JSON.stringify({ ok: false, errors: result.errors }, null, 2));
  process.exitCode = 1;
} else {
  console.log(JSON.stringify(result.summary, null, 2));
}
