import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

/**
 * A budget for the lane a contributor waits on.
 *
 * `ci.yml` was twenty-five jobs and ninety to a hundred and ten seconds. It got there one
 * defensible addition at a time — every job in it had a reason, and none of them was asked what it
 * cost. This is the place that asks.
 *
 * **What a job costs.** A job that runs one `echo` takes 5 to 16 seconds end to end: GitHub has to
 * find a machine, start a container, and tear it down. The run's wall clock is the *maximum* over
 * its jobs, not the sum — so a new job is free only if it finishes before the slowest one, and
 * expensive the moment it does not. A step added to `verify` or `test` is never free, because those
 * two are what the maximum is taken over today.
 *
 * **What to do when this fails.** Raise the number and say in the pull request what the addition
 * costs and why the release lane is the wrong home for it. That is the whole mechanism: nothing
 * here forbids growth, it just makes growth a sentence somebody has to write. `release-contract.yml`
 * has no budget, because nobody waits on it.
 *
 * Counts are exact rather than ceilings on purpose. A ceiling with slack is a licence to use the
 * slack, and a removed step should update the number too — a budget nobody has to touch is a budget
 * nobody reads.
 */

const root = resolve(import.meta.dirname, "../../..");

interface Job {
  "runs-on"?: string;
  strategy?: { matrix?: Record<string, unknown> };
  steps?: Array<{ run?: string; uses?: string }>;
}

const ci = parse(readFileSync(resolve(root, ".github/workflows/ci.yml"), "utf8")) as {
  jobs: Record<string, Job>;
};

const lockfile = readFileSync(resolve(root, "pnpm-lock.yaml"), "utf8");

/** Every job the pull-request lane may contain, and how many `run:` steps each may have. */
const BUDGET = {
  verify: 15,
  test: 4,
} as const;

/**
 * Three shards of the suite.
 *
 * Not a parallelism number. The slowest shard is 7.4s at three and 7.6s at four — the largest single
 * test file is the floor either way — while `verify` does 15 seconds of `run:` work, so `verify` is
 * what the run waits on and a fourth shard removes nothing from it. A job that takes nothing off the
 * critical path is a job this lane should not have.
 */
const SHARDS = 3;

/** Only what the prose below is allowed to say. A count spelled in digits is not the house style. */
const NUMBER_WORDS: Record<string, number> = {
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
};

/**
 * Every package the install resolves.
 *
 * This is the one thing neither budget could see. `scripts/check-ci-budget.mjs` measures `run:`
 * steps and deliberately ignores `actions/setup-node`, which is where a dependency shows up: that
 * step spends 4 to 9 seconds restoring a 57MB pnpm store, once per job, and the store is this
 * number. A dependency added carelessly slowed every job in the lane and failed nothing.
 *
 * Exact, like the step counts. A patch bump that moves it by three is a one-line diff, and that is
 * the point — the diff is what makes "this update brought forty packages with it" visible while
 * somebody can still ask whether it was worth it.
 */
const LOCKFILE_PACKAGES = 266;

const runSteps = (job: Job | undefined) => (job?.steps ?? []).filter((step) => step.run).length;

describe("the pull-request lane's budget", () => {
  it("contains these jobs and no others", () => {
    // A seventh job is not obviously free: see the note above this test about what a job costs.
    expect(Object.keys(ci.jobs).sort()).toEqual(Object.keys(BUDGET).sort());
  });

  it.each(Object.entries(BUDGET))("keeps %s to %i run steps", (name, allowed) => {
    expect(
      runSteps(ci.jobs[name]),
      `${name}: raise the budget in this file and say what the step costs`,
    ).toBe(allowed);
  });

  it(`splits the suite exactly ${SHARDS} ways`, () => {
    expect(ci.jobs.test?.strategy?.matrix?.shard).toHaveLength(SHARDS);
    const shardFlag = (ci.jobs.test?.steps ?? []).find((step) => step.run?.includes("--shard="));
    expect(shardFlag?.run).toContain(`/${SHARDS}`);
  });

  it("agrees with the one sentence in CONTRIBUTING that states the count", () => {
    // The count used to be prose in four places and three of them were wrong — six in one file,
    // four in two others, against a matrix of three. It is now one marked sentence; the workflow
    // comment, the table above it, and `platforms.md` say "sharded" and send a reader there.
    //
    // This checks the marker, not the file: other sentences may reason about three or four shards,
    // and the historical rows must be able to quote the counts they were measured against.
    const contributing = readFileSync(resolve(root, "CONTRIBUTING.md"), "utf8");
    const claims = [
      ...contributing.matchAll(/\*\*Current pull-request test shard count: (\w+)\./g),
    ];
    expect(claims, "CONTRIBUTING must carry exactly one current-count marker").toHaveLength(1);
    expect(NUMBER_WORDS[claims[0]?.[1] ?? ""]).toBe(SHARDS);
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
    // prose that sits close enough to the matrix to be believed without checking.
    const workflow = readFileSync(resolve(root, ".github/workflows/ci.yml"), "utf8");
    const comments = workflow
      .split("\n")
      .filter((line) => line.trimStart().startsWith("#"))
      .join("\n");
    expect(comments, "the shard count belongs in CONTRIBUTING, not in a comment").not.toMatch(
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
    }
  });

  it("resolves the number of packages it is budgeted", () => {
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
    expect(
      packages,
      "raise LOCKFILE_PACKAGES in this file and say in the pull request what the dependency buys",
    ).toBe(LOCKFILE_PACKAGES);
  });

  it("runs no version matrix here", () => {
    // A `node-version` matrix doubles a job. Both supported floors are proved by
    // `release-contract.yml`'s `suite-on-both-floors` after every merge, which is where a floor
    // claim belongs — see `docs/reference/platforms.md`.
    for (const [name, job] of Object.entries(ci.jobs)) {
      expect(job.strategy?.matrix?.["node-version"], name).toBeUndefined();
    }
  });
});
