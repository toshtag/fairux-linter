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

/** Every job the pull-request lane may contain, and how many `run:` steps each may have. */
const BUDGET = {
  verify: 15,
  test: 4,
} as const;

/** Four shards of the suite. Six was measured and was the same wall clock with two more runners. */
const SHARDS = 4;

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

  it("splits the suite exactly four ways", () => {
    expect(ci.jobs.test?.strategy?.matrix?.shard).toHaveLength(SHARDS);
    const shardFlag = (ci.jobs.test?.steps ?? []).find((step) => step.run?.includes("--shard="));
    expect(shardFlag?.run).toContain(`/${SHARDS}`);
  });

  it("runs no second platform here", () => {
    // Windows and macOS jobs are 50 to 80 seconds before they do anything. `config-windows` and
    // `pack-smoke-windows` live in `release-contract.yml` for exactly that reason, and a new one
    // belongs beside them. `ubuntu-latest` is x64 and slower here; it left with `link-check`.
    for (const [name, job] of Object.entries(ci.jobs)) {
      expect(String(job["runs-on"]), name).toMatch(/^ubuntu-/);
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
});
