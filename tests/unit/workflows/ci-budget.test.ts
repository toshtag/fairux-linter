import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

/**
 * A policy for the lane a contributor waits on.
 *
 * `ci.yml` was twenty-five jobs and ninety to a hundred and ten seconds. It got there one
 * defensible addition at a time — every job in it had a reason, and none of them was asked what it
 * cost. This is the place that asks.
 *
 * **What a job costs.** A job that runs one `echo` takes 5 to 16 seconds end to end: GitHub has to
 * find a machine, start a container, and tear it down. The run's wall clock is the *maximum* over
 * its jobs, not the sum — so a new job is free only if it finishes before the slowest one, and
 * expensive the moment it does not.
 *
 * ## What this checks, and what it stopped checking
 *
 * It used to be a snapshot: `verify` had to have exactly fifteen `run:` steps, `test` exactly four,
 * the matrix exactly three shards, the lockfile exactly 306 packages, and `CONTRIBUTING.md` had to
 * carry a sentence naming the shard count. The reasoning was that "a ceiling with slack is a licence
 * to use the slack, and a removed step should update the number too".
 *
 * That reasoning has a cost it did not account for. Every ordinary improvement — merging two checks
 * into one, dropping a step the build made redundant, a patch bump that resolves three fewer
 * packages — failed a test in a file that has nothing to do with the change, and the fix was to edit
 * a number somewhere else. A gate that fires when the lane gets *better* is a gate people learn to
 * silence.
 *
 * So what is checked here now is the shape the lane must not grow into:
 *
 * - only jobs whose role belongs on the critical path;
 * - a ceiling on `run:` steps per job, not an equality;
 * - no version matrix and no second platform, both of which double a job;
 * - the shard denominators inside the workflow agreeing with each other, whatever the count is.
 *
 * The tight gate is elsewhere and is a measurement rather than a shape: `scripts/check-ci-budget.mjs`
 * reads completed pull-request runs and fails when the median **work** in the slowest job passes its
 * ceiling in seconds. That is the number that notices a suite growing by half, which no step count
 * can see. This file is the backstop for the growth that changes the lane's character instead of its
 * duration.
 *
 * **What to do when this fails.** Say in the pull request what the addition costs and why the
 * release lane is the wrong home for it, then raise the ceiling. Nothing here forbids growth; it
 * makes growth a sentence somebody has to write. `release-contract.yml` has no budget, because
 * nobody waits on it.
 */

const root = resolve(import.meta.dirname, "../../..");

interface Job {
  name?: string;
  "runs-on"?: string;
  strategy?: { matrix?: Record<string, unknown> };
  steps?: Array<{ run?: string; uses?: string }>;
}

const ci = parse(readFileSync(resolve(root, ".github/workflows/ci.yml"), "utf8")) as {
  jobs: Record<string, Job>;
};

const lockfile = readFileSync(resolve(root, "pnpm-lock.yaml"), "utf8");

/**
 * The roles the pull-request lane may contain, and the most `run:` steps each may have.
 *
 * A ceiling, not a count. Below it, this file says nothing: a step removed, a check merged into
 * another, or a whole job dropped is an improvement, and an improvement should not have to edit a
 * number in a test to land. Above it, the job has stopped being what its role says it is.
 *
 * The roles are a closed set because a *new* job is the expensive case — 5 to 16 seconds of GitHub
 * before it does anything, on every push. Adding one to the lane means naming it here, which is the
 * sentence this file exists to extract. Removing one needs no edit.
 *
 * The ceilings have slack on purpose, and it is not slack to spend quietly: `check-ci-budget.mjs`
 * gates the seconds. What these bound is character. `verify` is the single-build job — twenty `run:`
 * steps is where "everything that needs one build" has become a workflow of its own. `test` is
 * install, build, the shard, and a worktree assertion — six is room for a setup step and not for a
 * second `verify` wearing the test job's name.
 */
const LANE = {
  /** Everything that needs one build and is not the test suite. */
  verify: 20,
  /** The suite, sharded. */
  test: 6,
} as const;

/**
 * The most packages the install may resolve.
 *
 * This is the one cost neither the step ceiling nor the seconds budget can see.
 * `scripts/check-ci-budget.mjs` measures `run:` steps and deliberately ignores
 * `actions/setup-node`, which is where a dependency shows up: that step spends 4 to 9 seconds
 * restoring the pnpm store, once per job, and the store is this number.
 *
 * It was an exact equality — 306, with a comment explaining the two jumps that got it there. The
 * equality made a patch bump that resolves three fewer packages a failing test, and the record it
 * bought is one the lockfile diff already gives: `pnpm-lock.yaml` is checked in, so a dependency
 * arrives as hundreds of reviewable lines whether or not a constant here moves.
 *
 * A ceiling keeps the part that is not in the diff. An ordinary update moves this by single digits
 * and never approaches it; the additions worth a conversation are the ones that arrive with a
 * toolchain attached — a framework, a browser driver, a test runner's own ecosystem — and those
 * land in the hundreds, in one commit.
 */
const MAX_LOCKFILE_PACKAGES = 500;

const runSteps = (job: Job | undefined) => (job?.steps ?? []).filter((step) => step.run).length;

describe("the pull-request lane's policy", () => {
  it("contains only jobs whose role belongs on the critical path", () => {
    // A subset, not an equality. Dropping a job from this lane is the improvement; adding one is
    // what has to be argued for, and adding one fails here until it is named above.
    for (const name of Object.keys(ci.jobs)) {
      expect(
        Object.keys(LANE),
        `${name}: a new job in this lane needs a role in ci-budget`,
      ).toContain(name);
    }
    expect(
      Object.keys(ci.jobs).length,
      "the lane is empty; this file would check nothing",
    ).toBeGreaterThan(0);
  });

  it.each(Object.entries(LANE))("keeps %s within %i run steps", (name, ceiling) => {
    // `toBeLessThanOrEqual`, so a lane that got shorter does not fail a test about it getting
    // longer. That inversion is why this file used to be edited by changes that improved it.
    expect(
      runSteps(ci.jobs[name]),
      `${name}: raise the ceiling in this file and say what the step costs`,
    ).toBeLessThanOrEqual(ceiling);
  });

  it("keeps the shard matrix and every denominator that names it in agreement", () => {
    // The count itself is the workflow's to decide. What cannot differ is the matrix, the
    // `--shard=` denominator, and the denominator in the job's display name — the three places a
    // shard count is written, of which two are strings GitHub Actions cannot compute for itself.
    // A matrix of four with `--shard=n/3` runs three quarters of the suite and reports success.
    const shards = ci.jobs.test?.strategy?.matrix?.shard;
    expect(Array.isArray(shards), "the test job has no shard matrix").toBe(true);
    const count = (shards as unknown[]).length;
    expect(shards).toEqual(Array.from({ length: count }, (_, index) => index + 1));

    const shardFlag = (ci.jobs.test?.steps ?? []).find((step) => step.run?.includes("--shard="));
    expect(shardFlag?.run, "no step passes --shard").toBeDefined();
    expect(shardFlag?.run).toContain(`/${count}`);
    expect(String(ci.jobs.test?.name)).toContain(`/${count})`);
  });

  it("does not count the lane's jobs in the prose that introduces it", () => {
    // `ci.yml` opened on "Three jobs, run at the same time" and set `PR_LANE_NODE` so "the six jobs
    // below cannot drift apart", above two definitions that expand to four. CONTRIBUTING said six.
    // Three numbers, none of them this lane's, and the shard guards did not look at the word "job".
    //
    // Scoped to the passages that describe the lane as it is. The measurement tables further down
    // may say six, because they were taken when it was.
    const workflow = readFileSync(resolve(root, ".github/workflows/ci.yml"), "utf8");
    const contributing = readFileSync(resolve(root, "CONTRIBUTING.md"), "utf8");
    const counted = /\b(one|two|three|four|five|six|\d+)\s+jobs?\b/i;

    const header = workflow.slice(0, workflow.indexOf("\non:"));
    const env = workflow.slice(workflow.indexOf("env:"), workflow.indexOf("PR_LANE_NODE"));
    const gate = contributing.slice(
      contributing.indexOf("`pnpm verify` is the baseline"),
      contributing.indexOf("## Scope-specific checks"),
    );

    for (const [name, passage] of Object.entries({ header, env, gate })) {
      expect(passage, `${name}: describe the lane, do not count it`).not.toMatch(counted);
    }
  });

  it("leaves the count out of the workflow comment that used to disagree with it", () => {
    // That comment opened "the suite in quarters" above a matrix of three. It is the one piece of
    // prose that sits close enough to the matrix to be believed without checking — and the matrix
    // is now the only place the count is written down at all.
    const workflow = readFileSync(resolve(root, ".github/workflows/ci.yml"), "utf8");
    const comments = workflow
      .split("\n")
      .filter((line) => line.trimStart().startsWith("#"))
      .join("\n");
    expect(comments, "the shard count is the matrix's to state").not.toMatch(
      /\b(two|three|four|five|six|eight)\b[^\n]*\bshard/i,
    );
    expect(comments).not.toMatch(/suite in (halves|thirds|quarters)/i);
  });

  it("runs no second platform here", () => {
    // Windows and macOS jobs are 50 to 80 seconds before they do anything. `config-windows` and
    // `pack-smoke-windows` live in `release-contract.yml` for exactly that reason, and a new one
    // belongs beside them. `ubuntu-latest` is x64 and slower here; it left with `link-check`.
    for (const [name, job] of Object.entries(ci.jobs)) {
      expect(String(job["runs-on"]), name).toMatch(/^ubuntu-/);
      expect(job.strategy?.matrix?.os, `${name}: a platform matrix doubles a job`).toBeUndefined();
    }
  });

  it("runs no version matrix here", () => {
    // A `node-version` matrix doubles a job. Both supported floors are proved by
    // `release-contract.yml`'s `suite-on-both-floors` after every merge, which is where a floor
    // claim belongs — see `docs/reference/platforms.md`.
    for (const [name, job] of Object.entries(ci.jobs)) {
      expect(job.strategy?.matrix?.["node-version"], name).toBeUndefined();
    }
  });

  it("resolves no more packages than it is budgeted", () => {
    // The `packages:` block, one entry per resolved package. Read from the lockfile rather than from
    // `node_modules`, so it is the same number on every machine and in a cold checkout. Scanned by
    // line rather than matched as a block: a regex for "everything until the next top-level key"
    // silently returned two entries instead of 266, and a miscount here would pass for ever.
    const lines = lockfile.split("\n");
    const start = lines.indexOf("packages:");
    expect(start, "pnpm-lock.yaml has no `packages:` section").toBeGreaterThanOrEqual(0);
    let packages = 0;
    for (const line of lines.slice(start + 1)) {
      if (/^\S/.test(line)) break; // the next top-level key
      if (/^ {2}[^\s#].*:$/.test(line)) packages += 1;
    }
    // A floor as well as a ceiling: a lockfile whose format moved would count zero and pass a
    // ceiling silently, which is the failure that hides every other one.
    expect(packages, "the packages scan found nothing; the lockfile format moved").toBeGreaterThan(
      50,
    );
    expect(
      packages,
      "raise the ceiling in this file and say in the pull request what the dependency buys",
    ).toBeLessThanOrEqual(MAX_LOCKFILE_PACKAGES);
  });
});
