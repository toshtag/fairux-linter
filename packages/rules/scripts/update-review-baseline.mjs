#!/usr/bin/env node
/**
 * Regenerate `rule-review-baseline.json` from the repository.
 *
 * No network, no GitHub API, no environment, no credentials, no arguments a person has to type. It
 * reads the built rule pack and the review records, computes the two hashes, and writes the file.
 * The flow this replaced asked a maintainer to run a workflow, approve a protected environment, and
 * then let a bot copy six values into JSON — for a change with no external side effect at all.
 *
 * `--check` writes nothing and exits non-zero if the file is stale, which is what CI runs.
 */

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { computeDetectionDigest } from "./detection-digest.mjs";
import { measureProbeBehaviour } from "./probe-runner.mjs";
import { computeReviewApprovalFingerprint } from "./review-approval-fingerprint.mjs";
import { buildReviewBaseline, serializeReviewBaseline } from "./review-baseline.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const BASELINE_PATH = join(ROOT, "packages/rules/reviews/rule-review-baseline.json");
const REVIEWS_PATH = join(ROOT, "packages/rules/reviews/built-in-rule-reviews.json");
const SOURCES_PATH = join(ROOT, "packages/rules/reviews/official-sources.json");
const CORE_PATH = join(ROOT, "packages/core/dist/index.js");
const RULES_PATH = join(ROOT, "packages/rules/dist/index.js");

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

/**
 * Measure the repository as it stands, from the **built** packages.
 *
 * Not from the sources: what a baseline describes is what a scan would run, and a build step that
 * dropped a rule would otherwise pass unnoticed.
 */
export async function measureReviewBaseline() {
  const core = await import(pathToFileURL(CORE_PATH).href);
  const rules = await import(pathToFileURL(RULES_PATH).href);
  const reviewRecords = readJson(REVIEWS_PATH);
  const fingerprint = computeReviewApprovalFingerprint({
    sourceCatalog: readJson(SOURCES_PATH),
    reviewRecords,
  });
  return buildReviewBaseline({
    reviewContentSha256: fingerprint.reviewContentSha256,
    detectionDigest: computeDetectionDigest({
      rules: rules.fairuxBuiltinRulePack.rules,
      journeyRules: rules.fairuxBuiltinRulePack.journeyRules,
      dictionary: rules.dictionary,
      pageContextKeywords: core.PAGE_CONTEXT_KEYWORDS,
      behaviour: await measureProbeBehaviour(ROOT),
    }),
    reviewRecords,
  });
}

/**
 * Formatted by Biome, like every other generated artifact here.
 *
 * `JSON.stringify` and the repository's formatter disagree, and a regenerated file that fails
 * `pnpm lint` the moment it is written would send everyone to fix a diff the tool just made.
 */
function writeFormatted(path, contents) {
  const result = spawnSync("pnpm", ["exec", "biome", "format", "--stdin-file-path", path], {
    cwd: ROOT,
    input: contents,
    encoding: "utf8",
  });
  if (result.status !== 0)
    throw new Error(result.stderr || `Biome failed while formatting ${path}`);
  writeFileSync(path, result.stdout, "utf8");
}

async function main() {
  const baseline = await measureReviewBaseline();
  const next = serializeReviewBaseline(baseline);

  if (process.argv.includes("--check")) {
    const current = readFileSync(BASELINE_PATH, "utf8");
    if (current.trim() === next.trim()) {
      process.stdout.write(`${JSON.stringify({ ok: true, ...baseline }, null, 2)}\n`);
      return;
    }
    console.error(
      "rule-review-baseline.json no longer describes this repository.\n" +
        "Run `pnpm rules:reviews:update` and include the regenerated file, the ruleVersion bump, and\n" +
        "the updated review record in the pull request.",
    );
    process.exit(1);
  }

  writeFormatted(BASELINE_PATH, next);
  process.stdout.write(
    `updated rule-review-baseline.json for ${baseline.rules.length} stable rules\n`,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
