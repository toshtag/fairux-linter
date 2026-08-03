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
 * The ceiling, in seconds, on the median **slowest job** — not on the run's wall clock.
 *
 * The first version of this budgeted the wall clock at 40s, and the wall clock is two things added
 * together. Fourteen first attempts, split:
 *
 *     slowest job   25 25 25 26 26 27 27 29 30 30 31 31 33 33   median 28s
 *     queue          2  2  2  2  3  3  3  3  3  3  6  7 14  —   median  3s
 *     wall clock    28 28 30 30 30 30 33 33 36 37 37 45 56 60   median 33s
 *
 * The middle row is GitHub finding machines. It reached 14 seconds on a run whose work was 31 — the
 * same tree that took 2 seconds to schedule an hour earlier. Budgeting the sum means a slow
 * afternoon in GitHub's pool turns `main` red for something no commit here caused, and the response
 * to that is to raise the budget, which is how a budget stops meaning anything.
 *
 * So the gate is the top row, which is what this repository decides, and 30 is the target it was
 * asked for. That is tight on purpose: four of those fourteen are already at or over it, so half of
 * them would have to be for this to fail — which is a regression rather than a bad afternoon.
 *
 * The wall clock is still printed, because it is what a contributor actually waits for. It is not
 * gated, because nothing in this repository can move it.
 *
 * Raising this is allowed and is the point: do it in a pull request that says what got slower and
 * why that was the right trade. Silently raising it is the failure this file exists to make awkward.
 */
const BUDGET_SECONDS = 30;

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

async function api(url, token) {
  const headers = { accept: "application/vnd.github+json" };
  if (token) headers.authorization = `Bearer ${token}`;
  const response = await fetch(url, { headers });
  if (!response.ok) {
    fail(`GitHub returned ${response.status} ${response.statusText} for ${url}`);
  }
  return response.json();
}

async function runs(slug, token) {
  const url =
    `https://api.github.com/repos/${slug}/actions/workflows/${WORKFLOW}/runs` +
    `?event=pull_request&status=success&per_page=${PAGE_SIZE}`;
  const body = await api(url, token);
  if (!Array.isArray(body?.workflow_runs)) {
    fail(`GitHub's response has no workflow_runs array — the API or the workflow name has moved`);
  }
  // `total_count` is 0 when the workflow itself is gone, which a plain empty array would hide.
  if (body.total_count === 0) {
    fail(`no successful pull-request runs of ${WORKFLOW} exist at all — has it been renamed?`);
  }
  return body.workflow_runs;
}

const elapsed = (from, to) => Math.round((Date.parse(to) - Date.parse(from)) / 1000);

/**
 * One run, split into the part this repository decides and the part GitHub does.
 *
 * `slowest` is the longest job: the run's jobs are concurrent, so this is the work the wall clock
 * is waiting on. `queue` is how long the first job took to get a machine. They do not sum exactly
 * to `wall` — later jobs queue separately — which is why all three are reported rather than two
 * being derived from the third.
 */
async function split(slug, token, run) {
  const jobs = await api(`https://api.github.com/repos/${slug}/actions/runs/${run.id}/jobs`, token);
  if (!Array.isArray(jobs?.jobs) || jobs.jobs.length === 0) {
    fail(`run ${run.run_number} reports no jobs — the API has moved`);
  }
  const started = run.run_started_at ?? run.created_at;
  return {
    number: run.run_number,
    wall: elapsed(started, run.updated_at),
    slowest: Math.max(...jobs.jobs.map((job) => elapsed(job.started_at, job.completed_at))),
    queue: Math.min(...jobs.jobs.map((job) => elapsed(started, job.started_at))),
  };
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length / 2;
  return sorted.length % 2 ? sorted[Math.floor(middle)] : (sorted[middle - 1] + sorted[middle]) / 2;
}

const slug = repository();
const token = process.env.GITHUB_TOKEN;
const recent = (await runs(slug, token))
  .filter((run) => (run.run_attempt ?? 1) === 1)
  .slice(0, WINDOW);

if (recent.length < MIN_SAMPLES) {
  console.log(
    `Inconclusive: ${recent.length} first-attempt pull-request run(s) of ${WORKFLOW}, need ${MIN_SAMPLES}.`,
  );
  console.log("Not a failure — there is nothing to take a median of yet.");
  process.exit(0);
}

const samples = await Promise.all(recent.map((run) => split(slug, token, run)));
const slowest = median(samples.map((sample) => sample.slowest));
const wall = median(samples.map((sample) => sample.wall));
const queue = median(samples.map((sample) => sample.queue));
const range = (key) => {
  const values = samples.map((sample) => sample[key]);
  return `${Math.min(...values)}–${Math.max(...values)}s`;
};

console.log(`${WORKFLOW}, last ${samples.length} first-attempt pull-request runs:`);
console.log(
  `  ${"run".padStart(6)} ${"slowest job".padStart(12)} ${"queue".padStart(7)} ${"wall".padStart(6)}`,
);
for (const sample of samples) {
  console.log(
    `  ${String(sample.number).padStart(6)} ${`${sample.slowest}s`.padStart(12)}` +
      ` ${`${sample.queue}s`.padStart(7)} ${`${sample.wall}s`.padStart(6)}`,
  );
}
console.log(
  `\n  slowest job  median ${slowest}s   range ${range("slowest")}   budget ${BUDGET_SECONDS}s`,
);
// Reported, never gated: this is GitHub finding machines, and no commit in this repository moves it.
console.log(
  `  queue        median ${queue}s   range ${range("queue")}   not budgeted — GitHub's pool`,
);
console.log(
  `  wall clock   median ${wall}s   range ${range("wall")}   what a contributor waits for`,
);

if (slowest > BUDGET_SECONDS) {
  console.error("");
  fail(
    `the median slowest job is ${slowest}s, over the ${BUDGET_SECONDS}s budget.\n` +
      `That is work this repository added, not a slow afternoon in GitHub's runner pool — the queue\n` +
      `column above is where that would show. Either give back what got slower, or raise\n` +
      `BUDGET_SECONDS in this file and say in the pull request what it bought.`,
  );
}

const slack = BUDGET_SECONDS - slowest;
console.log(`\nWithin budget by ${slack}s.`);

// A budget only ratchets if somebody is told when it has gone slack. Without this the number set
// once when the lane was slow outlives every improvement made to it, and stops meaning anything.
if (slack >= 8) {
  console.log(
    `The budget has ${slack}s of slack. If that holds for a while, lower BUDGET_SECONDS in this\n` +
      `file — a ceiling nobody can reach is not a ceiling.`,
  );
}
