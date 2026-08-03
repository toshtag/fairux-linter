#!/usr/bin/env node
/**
 * How long the lane a contributor waits on actually takes, against the budget it is allowed.
 *
 * `tests/unit/workflows/ci-budget.test.ts` bounds the *shape* of `ci.yml` — its jobs, its steps, its
 * shards — and a shape budget cannot see the one way CI gets slower without anyone adding anything:
 * the suite growing. Fifty new rule tests do not change a step count. They change this number.
 *
 * It reads completed pull-request runs rather than pushes to `main`, because those are the runs
 * somebody is waiting for, and because a push to `main` starts `release-contract.yml` at the same
 * time and the two compete for runners — main runs measure GitHub's queue, not this repository.
 *
 * First attempts only. A re-run reports the same tree twice and its `updated_at` moves, so counting
 * re-runs would let one slow afternoon of retries look like a regression.
 *
 * Fail-closed about the mechanism, tolerant about the data. A missing workflow, an API error, or a
 * response that is not the shape this expects all exit non-zero — those mean the check has stopped
 * checking, which is the failure that hides every other one. Too few runs to have a median is a
 * different thing: it is honestly inconclusive, it says so, and it exits 0 rather than painting
 * `main` red because nobody has opened a pull request yet.
 */

import { execFileSync } from "node:child_process";

/**
 * The ceiling, in seconds, on the median pull-request run.
 *
 * The lane measured 27–30s across ten samples when this was written (PR #232, on the arm64
 * runners). 35 leaves room for GitHub's own variance — a job that runs one `echo` takes 5 to 16
 * seconds end to end — while still failing on a regression a contributor would feel.
 *
 * Raising it is allowed and is the point: do it in a pull request that says what got slower and
 * why that was the right trade. Silently raising it is the failure this file exists to make
 * awkward.
 */
const BUDGET_SECONDS = 35;

/** Below this many samples there is no median worth acting on. */
const MIN_SAMPLES = 5;

/**
 * How many first attempts the median is taken over.
 *
 * Short on purpose. This is a drift check, and a window wide enough to reach back past the last
 * change to the lane is measuring history — the first run of this script read forty-five runs and
 * reported a median of 93s, which was the truth about a workflow that had not existed for hours.
 */
const WINDOW = 10;

/** How many runs to ask for. Enough that WINDOW first attempts survive the filter. */
const PAGE_SIZE = 50;

const WORKFLOW = "ci.yml";

function fail(message) {
  console.error(`ERROR: ${message}`);
  process.exit(1);
}

function repository() {
  if (process.env.GITHUB_REPOSITORY) return process.env.GITHUB_REPOSITORY;
  // Local runs: read the origin remote rather than asking anyone to pass a flag.
  const remote = execFileSync("git", ["remote", "get-url", "origin"], { encoding: "utf8" }).trim();
  const match = /github\.com[:/](?<slug>[^/]+\/[^/]+?)(?:\.git)?$/.exec(remote);
  if (!match?.groups?.slug) fail(`cannot read an owner/repo out of the origin remote: ${remote}`);
  return match.groups.slug;
}

async function runs(slug, token) {
  const url =
    `https://api.github.com/repos/${slug}/actions/workflows/${WORKFLOW}/runs` +
    `?event=pull_request&status=success&per_page=${PAGE_SIZE}`;
  const headers = { accept: "application/vnd.github+json" };
  if (token) headers.authorization = `Bearer ${token}`;

  const response = await fetch(url, { headers });
  if (!response.ok) {
    fail(`GitHub returned ${response.status} ${response.statusText} for ${WORKFLOW}'s runs`);
  }
  const body = await response.json();
  if (!Array.isArray(body?.workflow_runs)) {
    fail(`GitHub's response has no workflow_runs array — the API or the workflow name has moved`);
  }
  // `total_count` is 0 when the workflow itself is gone, which a plain empty array would hide.
  if (body.total_count === 0) {
    fail(`no successful pull-request runs of ${WORKFLOW} exist at all — has it been renamed?`);
  }
  return body.workflow_runs;
}

function seconds(run) {
  const started = Date.parse(run.run_started_at ?? run.created_at);
  const ended = Date.parse(run.updated_at);
  if (!Number.isFinite(started) || !Number.isFinite(ended)) return undefined;
  return Math.round((ended - started) / 1000);
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length / 2;
  return sorted.length % 2 ? sorted[Math.floor(middle)] : (sorted[middle - 1] + sorted[middle]) / 2;
}

const slug = repository();
const samples = (await runs(slug, process.env.GITHUB_TOKEN))
  .filter((run) => (run.run_attempt ?? 1) === 1)
  .map((run) => ({ number: run.run_number, seconds: seconds(run) }))
  .filter((sample) => typeof sample.seconds === "number")
  .slice(0, WINDOW);

if (samples.length < MIN_SAMPLES) {
  console.log(
    `Inconclusive: ${samples.length} first-attempt pull-request run(s) of ${WORKFLOW}, need ${MIN_SAMPLES}.`,
  );
  console.log("Not a failure — there is nothing to take a median of yet.");
  process.exit(0);
}

const durations = samples.map((sample) => sample.seconds);
const middle = median(durations);
const spread = `${Math.min(...durations)}–${Math.max(...durations)}s`;

console.log(`${WORKFLOW}, last ${samples.length} first-attempt pull-request runs:`);
console.log(`  ${durations.join("s  ")}s`);
console.log(`  median ${middle}s   range ${spread}   budget ${BUDGET_SECONDS}s`);

if (middle > BUDGET_SECONDS) {
  console.error("");
  fail(
    `the median pull-request run is ${middle}s, over the ${BUDGET_SECONDS}s budget.\n` +
      `Either give back what got slower, or raise BUDGET_SECONDS in this file and say in the pull\n` +
      `request what it bought. A budget that moves without a sentence beside it is not a budget.`,
  );
}

const slack = BUDGET_SECONDS - middle;
console.log(`\nWithin budget by ${slack}s.`);

// A budget only ratchets if somebody is told when it has gone slack. Without this the number set
// once when the lane was slow outlives every improvement made to it, and stops meaning anything.
if (slack >= 8) {
  console.log(
    `The budget has ${slack}s of slack. If that holds for a while, lower BUDGET_SECONDS in this\n` +
      `file — a ceiling nobody can reach is not a ceiling.`,
  );
}
