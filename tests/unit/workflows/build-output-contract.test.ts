import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

/**
 * The build-output gate is only worth as much as its position in CI.
 *
 * Issue #57 survived a green pipeline because `verify` ran `pnpm lint` *before* `pnpm build` and
 * never looked again. These assertions pin the ordering and the idempotency job so a future
 * reshuffle cannot quietly restore that blind spot.
 */

const root = resolve(import.meta.dirname, "../../..");

interface Workflow {
  jobs: Record<string, { steps?: Array<{ name?: string; run?: string; uses?: string }> }>;
}

const read = (file: string): Workflow =>
  parse(readFileSync(resolve(root, ".github/workflows", file), "utf8"));

const ci = read("ci.yml");
const releaseContract = read("release-contract.yml");

const runSteps = (workflow: Workflow, jobName: string): string[] =>
  (workflow.jobs[jobName]?.steps ?? []).flatMap((step) => (step.run ? [step.run] : []));

const indexOfStep = (workflow: Workflow, jobName: string, needle: string): number =>
  runSteps(workflow, jobName).findIndex((run) => run.includes(needle));

const assertsWorktreeClean = (workflow: Workflow, jobName: string): boolean =>
  runSteps(workflow, jobName).some(
    (run) => run.includes("git diff --exit-code") && run.includes("git status --porcelain"),
  );

describe("CI build output gate", () => {
  it("checks the build output contract after building, in verify", () => {
    const build = indexOfStep(ci, "verify", "pnpm build");
    const check = indexOfStep(ci, "verify", "pnpm check:build-output");

    expect(build).toBeGreaterThanOrEqual(0);
    expect(check).toBeGreaterThan(build);
  });

  it("lints again after the build, not only before it", () => {
    const steps = runSteps(ci, "verify");
    const build = steps.findIndex((run) => run.includes("pnpm build"));
    const lintsAfterBuild = steps.slice(build + 1).filter((run) => run.trim() === "pnpm lint");

    expect(build).toBeGreaterThanOrEqual(0);
    expect(lintsAfterBuild.length).toBeGreaterThanOrEqual(1);
  });

  it("asserts the worktree is clean after verify's build, typecheck, and test", () => {
    expect(assertsWorktreeClean(ci, "verify")).toBe(true);
  });
});

describe("CI build idempotency job", () => {
  it("builds twice and compares artifact digests", () => {
    const steps = runSteps(releaseContract, "build-output-contract");
    const builds = steps.filter((run) => run.includes("pnpm build"));

    expect(builds.length).toBe(2);
    expect(steps.some((run) => run.includes("sha256sum"))).toBe(true);
    expect(steps.some((run) => run.includes("diff -u"))).toBe(true);
  });

  it("re-checks the build output contract on both builds", () => {
    const checks = runSteps(releaseContract, "build-output-contract").filter((run) =>
      run.includes("pnpm check:build-output"),
    );

    expect(checks.length).toBe(2);
  });

  it("lints after a build and asserts a clean worktree", () => {
    const steps = runSteps(releaseContract, "build-output-contract");

    expect(steps.some((run) => run.trim() === "pnpm lint")).toBe(true);
    expect(assertsWorktreeClean(releaseContract, "build-output-contract")).toBe(true);
  });
});

describe("CI release-path worktree cleanliness", () => {
  it.each(["pack-smoke", "sdk-pack-smoke", "sdk-release-preflight"])(
    "asserts %s leaves the worktree clean",
    (jobName) => {
      expect(assertsWorktreeClean(releaseContract, jobName)).toBe(true);
    },
  );
});
