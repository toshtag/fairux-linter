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
import { currentTreePullRequest, decideBudget, runForHead } from "./ci-budget-contract.mjs";

/**
 * The ceiling, in seconds, on the median **work** in the slowest job — the `run:` steps, and
 * nothing GitHub does around them.
 *
 * This budget has been wrong twice, in the same direction, and the correction is worth keeping.
 * Version one capped the run's wall clock. Version two capped the slowest job, having noticed the
 * wall clock includes the wait for a machine. Both still measured GitHub. Fourteen first attempts,
 * decomposed properly:
 *
 *     work (`run:` steps)   13 13 13 13 13 13 13 13 14 14 14 14 14 15   median 13s   spread  2s
 *     checkout               1  1  1  2  2  2  2  2  3  6 21 33 36  —   median  2s   spread 35s
 *     setup-node             4  5  5  5  5  6  6  6  6  6  8  8  9  —   median  6s
 *     slowest job           25 25 25 26 26 27 27 29 30 31 33 44 56 60   median 28s   spread 35s
 *     wall clock            28 28 30 30 30 33 36 37 50 56 58 60 64  —   median 34s   spread 36s
 *
 * Every row but the first is GitHub's. `actions/checkout` on a 5.4MB repository took 36 seconds on
 * one job while another job in the *same run* took 2 — that is the term that made the slowest job
 * look like it moved. The first row is what this repository puts in the lane, and across fourteen
 * runs it varies by two seconds.
 *
 * So the gate is the first row. 18 was about a third above its 15s ceiling: high enough that no
 * observed run came near it, low enough that a step added to `verify` or a suite grown by half
 * would trip it. Everything else is printed and never gated, because a check that fails on what you
 * cannot fix teaches people to rerun it.
 *
 * Raising this is allowed and is the point: do it in a pull request that says what got slower and
 * why that was the right trade. Silently raising it is the failure this file exists to make awkward.
 *
 * **18 → 20, and what the two seconds bought.** This beta's audit added four CLI suites that drive
 * the built binary — report-envelope integrity, external-filter provenance, the invocation and
 * remediation contracts, and the changelog boundary — about sixty cases, most of them spawning
 * `fairux` and reading what a user would actually see. That is the kind of test this repository has
 * repeatedly found defects with, and it is not cheap: a spawn is a process start plus a scan.
 *
 * Given back first, and measured, before any of this was written down. Twenty-six of those spawns
 * were the *same scan* — each case re-asking the CLI for the fingerprints of one unchanging fixture
 * page so it could write the filter files it tests. Discovered once per file instead:
 *
 *     shard 1 file time     126.2s → 60.8s
 *     suppress-with-baseline  12.3s →  6.8s
 *     slowest job (run 651)      —  →   19s
 *
 * With the shards balanced (19s, 17s, 16s, and 13s for `verify`) there is no lopsided suite left to
 * move and no duplicate scan left to remove. 20 is one second above what the lane now measures,
 * which is deliberately tight: the next second of growth trips this again and somebody looks.
 *
 * Adding a fourth shard would have lowered this number without lowering the work, which is the same
 * failure as raising the budget quietly — with a runner spent on it.
 */
const BUDGET_SECONDS = 20;

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

/**
 * The commit this run is gating.
 *
 * `GITHUB_SHA` on a push to `main`; the local `HEAD` otherwise, so running this by hand judges the
 * tree in front of you rather than whatever finished last on the server.
 */
function gatedCommit() {
  if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA;
  return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
}

/**
 * The pull requests a commit appears in.
 *
 * Needs `pull-requests: read`, which the job now asks for. A 403 here is a permission the workflow
 * did not grant, and `api()` fails on it rather than returning an empty list — an empty list would
 * read as "a direct push" and quietly change the verdict.
 */
async function pullsFor(slug, sha, token) {
  return api(`https://api.github.com/repos/${slug}/commits/${sha}/pulls`, token);
}

const elapsed = (from, to) => Math.round((Date.parse(to) - Date.parse(from)) / 1000);

/**
 * A step GitHub runs, rather than one this repository wrote.
 *
 * The jobs API names a step by its `name:`, or by `Run <what it does>` when there is none — so a
 * `uses:` step reads `Run actions/checkout@<sha>` and a `run:` step reads `Run pnpm build`. The
 * owner/repo shape is what separates them; `Set up job`, `Complete job`, and the `Post Run` cleanups
 * have no `run:` counterpart at all.
 */
const GITHUB_STEP = /^Run [\w.-]+\/[\w.-]+@|^Post Run |^(?:Set up job|Complete job)$/;

/**
 * One run, split into the part this repository decides and the parts GitHub does.
 *
 * `work` is the largest per-job sum of `run:` steps: the jobs are concurrent, so this is the most
 * work any one of them was asked to do. `slowest` is that same job's whole duration, and the gap
 * between them is checkout, `setup-node`, and GitHub's own start and teardown. `queue` is how long
 * the first job took to get a machine. None of them sum exactly to `wall`, which is why each is
 * reported rather than derived.
 */
async function split(slug, token, run) {
  const jobs = await api(`https://api.github.com/repos/${slug}/actions/runs/${run.id}/jobs`, token);
  if (!Array.isArray(jobs?.jobs) || jobs.jobs.length === 0) {
    fail(`run ${run.run_number} reports no jobs — the API has moved`);
  }
  const started = run.run_started_at ?? run.created_at;
  const workOf = (job) =>
    (job.steps ?? [])
      .filter((step) => step.completed_at && !GITHUB_STEP.test(step.name))
      .reduce((total, step) => total + elapsed(step.started_at, step.completed_at), 0);
  const stepOf = (job, prefix) =>
    (job.steps ?? [])
      .filter((step) => step.completed_at && step.name.startsWith(prefix))
      .reduce((most, step) => Math.max(most, elapsed(step.started_at, step.completed_at)), 0);
  return {
    number: run.run_number,
    work: Math.max(...jobs.jobs.map(workOf)),
    checkout: Math.max(...jobs.jobs.map((job) => stepOf(job, "Run actions/checkout"))),
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

// A run whose `run:` steps sum to nothing did not happen. `GITHUB_STEP` is what separates the work
// from the scaffolding, and a regex that grew to match everything would zero this column and pass
// every budget for ever — the one direction the failures above cannot catch, because too little
// work looks exactly like a fast lane.
const empty = samples.filter((sample) => sample.work === 0);
if (empty.length > 0) {
  fail(
    `${empty.length} of ${samples.length} runs report no work at all (${empty
      .map((sample) => sample.number)
      .join(", ")}).\n` +
      `GITHUB_STEP is classifying \`run:\` steps as GitHub's own, so this budget is measuring nothing.`,
  );
}
const work = median(samples.map((sample) => sample.work));
const range = (key) => {
  const values = samples.map((sample) => sample[key]);
  return `${Math.min(...values)}–${Math.max(...values)}s`;
};
const line = (label, key, note) =>
  `  ${label.padEnd(13)}median ${`${median(samples.map((s) => s[key]))}s`.padEnd(7)} range ${range(key).padEnd(9)} ${note}`;

console.log(`${WORKFLOW}, last ${samples.length} first-attempt pull-request runs:`);
console.log(
  `  ${"run".padStart(6)} ${"work".padStart(6)} ${"checkout".padStart(9)} ${"slowest".padStart(8)} ${"queue".padStart(6)} ${"wall".padStart(6)}`,
);
for (const s of samples) {
  console.log(
    `  ${String(s.number).padStart(6)} ${`${s.work}s`.padStart(6)} ${`${s.checkout}s`.padStart(9)}` +
      ` ${`${s.slowest}s`.padStart(8)} ${`${s.queue}s`.padStart(6)} ${`${s.wall}s`.padStart(6)}`,
  );
}
console.log("");
console.log(
  line(
    "work",
    "work",
    `budget ${BUDGET_SECONDS}s — the \`run:\` steps, and all this repository decides`,
  ),
);
// Reported, never gated. `actions/checkout` took 36s on one job of a run whose other job took 2s,
// on a 5.4MB repository; no commit here moves that, and failing on it would teach people to rerun.
console.log(line("checkout", "checkout", "not budgeted — GitHub fetching a 5.4MB repository"));
console.log(line("queue", "queue", "not budgeted — GitHub finding a machine"));
console.log(line("slowest job", "slowest", "work plus both of the above"));
console.log(line("wall clock", "wall", "what a contributor waits for"));

/**
 * The run for *this* tree — the one the exemption is allowed to rest on.
 *
 * The median is the drift signal and stays that. What it cannot do is notice that somebody fixed
 * the thing: a ten-run trailing median carries nine runs of a tree that no longer exists, so a pull
 * request that genuinely gives the seconds back leaves this red for about five more pull requests.
 * That is the failure this file argues against further up — a check that fails on what you cannot
 * fix teaches people to rerun it, and one that fails on what you *already fixed* teaches them
 * faster.
 *
 * The first version of that exemption read the current cost off `samples[0]`, the newest successful
 * pull-request run in the repository. That is not this tree. `release-contract.yml` runs on a push
 * to `main`, and the newest pull-request run at that moment belongs to whichever branch finished
 * last — an open pull request, a closed one, somebody else's. It was wrong in both directions: an
 * unrelated fast run exempts a `main` that really is over budget, and an unrelated slow run fails a
 * `main` that has already been fixed.
 *
 * Chosen by identity now: the merged pull request that produced this commit, and the first-attempt
 * run for that pull request's head. When there is no such thing — a direct push, two merged pull
 * requests claiming one commit, no run for the head — there is nothing to grant an exemption with,
 * and a median over budget fails saying so. The selection rules are in `ci-budget-contract.mjs`,
 * where they can be tested without the API.
 */
const sha = gatedCommit();
const pull = currentTreePullRequest(await pullsFor(slug, sha, token), sha);
let currentTree = pull;
if (pull.ok) {
  const found = runForHead(recent, pull.headSha);
  currentTree = found.ok
    ? {
        ok: true,
        work: (await split(slug, token, found.run)).work,
        label: `run ${found.run.run_number} (pull request #${pull.number}, head ${pull.headSha.slice(0, 7)})`,
      }
    : found;
}

const decision = decideBudget({ median: work, currentTree, budgetSeconds: BUDGET_SECONDS });

if (decision.code === "over-budget") {
  console.error("");
  fail(
    `the median work in the slowest job is ${work}s, over the ${BUDGET_SECONDS}s budget, and this\n` +
      `tree's own run is ${decision.current.work}s — ${decision.current.label}. So this is where the\n` +
      `lane is, not where it was. This is run-step time only, so it is not a slow checkout and not a\n` +
      `slow afternoon in GitHub's runner pool — both of those have their own row above and neither is\n` +
      `gated. Either give back what got slower, or raise BUDGET_SECONDS in this file and say in the\n` +
      `pull request what it bought.`,
  );
}

if (decision.code === "no-current-tree") {
  console.error("");
  fail(
    `the median work in the slowest job is ${work}s, over the ${BUDGET_SECONDS}s budget, and this\n` +
      `tree has no run of its own to judge it by: ${decision.detail}.\n` +
      `The newest run in the window is deliberately not used instead — it belongs to whichever branch\n` +
      `finished last, which is not this commit, and substituting it is how a lane over budget gets\n` +
      `exempted by somebody else's fast pull request.`,
  );
}

if (decision.code === "improving") {
  // Said out loud rather than passed silently, because the next few runs will keep looking bad and
  // somebody will ask.
  console.log(
    `\nThe median is ${work}s, over the ${BUDGET_SECONDS}s budget, and this tree's own run is\n` +
      `${decision.current.work}s — ${decision.current.label}. The window still reaches back past\n` +
      `whatever gave the seconds back; it will follow. Not failing on a number the tree no longer\n` +
      `produces.`,
  );
  process.exit(0);
}

const slack = BUDGET_SECONDS - work;
console.log(`\nWithin budget by ${slack}s.`);

// A budget only ratchets if somebody is told when it has gone slack. Without this the number set
// once when the lane was slow outlives every improvement made to it, and stops meaning anything.
if (slack >= 8) {
  console.log(
    `The budget has ${slack}s of slack. If that holds for a while, lower BUDGET_SECONDS in this\n` +
      `file — a ceiling nobody can reach is not a ceiling.`,
  );
}
