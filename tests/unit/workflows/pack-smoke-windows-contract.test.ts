import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

/**
 * What the Windows packed-CLI job has to keep doing.
 *
 * A platform matrix decays quietly. Dropping a Node floor, swapping `pnpm pack:smoke` for a unit
 * test, moving the job to Ubuntu, or adding `continue-on-error: true` all leave a green check with
 * the same name — and this job is the only place the published CLI is ever installed and run on
 * Windows, so the check going hollow is indistinguishable from the coverage existing.
 *
 * The rules are a pure function over the parsed job so the mutation cases below can drive it with
 * jobs the workflow does not contain: each one is a specific way this job could be weakened, and
 * each is asserted to be *caught*. A contract test that only ever sees the passing input proves
 * that the input passes, not that anything else would fail.
 */

const root = resolve(import.meta.dirname, "../../..");

interface Step {
  name?: string;
  run?: string;
  uses?: string;
  shell?: string;
  with?: Record<string, unknown>;
  "continue-on-error"?: boolean;
}

interface Job {
  name?: string;
  "runs-on"?: string;
  "timeout-minutes"?: number;
  "continue-on-error"?: boolean;
  permissions?: Record<string, string>;
  strategy?: { "fail-fast"?: boolean; matrix?: { "node-version"?: string[] } };
  steps?: Step[];
}

interface Workflow {
  jobs: Record<string, Job>;
}

const workflow: Workflow = parse(readFileSync(resolve(root, ".github/workflows/ci.yml"), "utf8"));

const SUPPORTED_NODE_FLOORS = ["22.18.0", "24.11.0"];

/** Commands that would turn a verification job into one that changes published state. */
const PUBLISHING_COMMANDS = [
  "npm publish",
  "pnpm publish",
  "gh release",
  "git tag",
  "git push",
  "npm dist-tag",
];

/**
 * @returns the ways `job` falls short of the Windows packed-CLI contract; empty means it holds
 */
function auditPackSmokeWindowsJob(job: Job | undefined): string[] {
  if (!job) return ["the job does not exist"];
  const failures: string[] = [];
  const steps = job.steps ?? [];
  const runs = steps.flatMap((step) => (step.run ? [step.run] : []));

  if (job["runs-on"] !== "windows-latest") {
    failures.push(`runs on ${job["runs-on"]}, not windows-latest`);
  }

  const floors = job.strategy?.matrix?.["node-version"] ?? [];
  for (const floor of SUPPORTED_NODE_FLOORS) {
    if (!floors.includes(floor)) failures.push(`does not run on Node ${floor}`);
  }
  for (const floor of floors) {
    if (!SUPPORTED_NODE_FLOORS.includes(floor)) failures.push(`runs on unsupported Node ${floor}`);
  }
  // Without this a failure on one floor hides the other floor's result.
  if (job.strategy?.["fail-fast"] !== false) failures.push("does not set fail-fast: false");

  if (!runs.some((run) => run.includes("node scripts/check-pnpm-selection.mjs"))) {
    failures.push("does not assert the resolved pnpm is the one packageManager names");
  }
  if (!runs.some((run) => run.includes("pnpm install --frozen-lockfile"))) {
    failures.push("does not install from the frozen lockfile");
  }
  // The packed smoke specifically: a unit-test run would exercise the workspace, not the artifact.
  if (!runs.some((run) => run.trim() === "pnpm pack:smoke")) {
    failures.push("does not run pnpm pack:smoke");
  }
  if (
    !runs.some(
      (run) => run.includes("git diff --exit-code") && run.includes("git status --porcelain"),
    )
  ) {
    failures.push("does not assert the worktree is left clean");
  }

  // A failing step that does not fail the job is the most invisible way this job can rot.
  if (job["continue-on-error"] === true) failures.push("the job sets continue-on-error");
  for (const step of steps) {
    if (step["continue-on-error"] === true) {
      failures.push(`a step sets continue-on-error: ${step.name ?? step.run ?? step.uses}`);
    }
  }

  // This job verifies; it must not be able to write anything, and must not be handed an OIDC
  // identity it could exchange for registry credentials.
  for (const [scope, level] of Object.entries(job.permissions ?? {})) {
    if (level !== "read" && level !== "none") {
      failures.push(`grants ${scope}: ${level}`);
    }
  }
  for (const run of runs) {
    for (const command of PUBLISHING_COMMANDS) {
      if (run.includes(command)) failures.push(`runs a state-changing command: ${command}`);
    }
  }

  // Every action pinned to a full commit SHA, as elsewhere in this workflow.
  for (const step of steps) {
    if (step.uses && !/@[0-9a-f]{40}$/.test(step.uses)) {
      failures.push(`action is not pinned to a full commit SHA: ${step.uses}`);
    }
  }

  return failures;
}

const job = workflow.jobs["pack-smoke-windows"];

/** A structural copy of the real job, for a mutation to be applied to. */
const mutated = (change: (copy: Job) => void): Job => {
  const copy = structuredClone(job) as Job;
  change(copy);
  return copy;
};

describe("CI Windows packed-CLI job", () => {
  it("satisfies the contract", () => {
    expect(auditPackSmokeWindowsJob(job)).toEqual([]);
  });

  it("pins the same action versions the Linux pack smoke uses", () => {
    // Two jobs installing the same lockfile with different action revisions is a difference the
    // matrix would attribute to the platform.
    const usesOf = (name: string) =>
      (workflow.jobs[name]?.steps ?? []).flatMap((step) => (step.uses ? [step.uses] : []));

    expect(usesOf("pack-smoke-windows")).toEqual(usesOf("pack-smoke"));
  });

  it("keeps the Linux pack smoke and the Windows config job alongside it", () => {
    // This job adds a platform; it replaces neither the Linux matrix nor the workspace-level
    // Windows config checks.
    expect(workflow.jobs["pack-smoke"]).toBeDefined();
    expect(workflow.jobs["config-windows"]).toBeDefined();
  });

  it("runs the worktree check under a shell that stops on the first failure", () => {
    // The runner's default on Windows is `pwsh`, which reports only the last command's status: a
    // dirty worktree caught by `git diff` would not fail the step.
    const cleanCheck = (job?.steps ?? []).find((step) =>
      step.run?.includes("git status --porcelain"),
    );
    expect(cleanCheck?.shell).toBe("bash");
  });
});

describe("the Windows packed-CLI contract catches a weakened job", () => {
  it("catches a dropped Node floor", () => {
    const weakened = mutated((copy) => {
      copy.strategy = { ...copy.strategy, matrix: { "node-version": ["22.18.0"] } };
    });
    expect(auditPackSmokeWindowsJob(weakened)).toContain("does not run on Node 24.11.0");
  });

  it("catches the packed smoke being replaced by a unit-test run", () => {
    const weakened = mutated((copy) => {
      for (const step of copy.steps ?? []) {
        if (step.run?.trim() === "pnpm pack:smoke") step.run = "pnpm exec vitest run apps/cli/test";
      }
    });
    expect(auditPackSmokeWindowsJob(weakened)).toContain("does not run pnpm pack:smoke");
  });

  it("catches the job being moved off Windows", () => {
    const weakened = mutated((copy) => {
      copy["runs-on"] = "ubuntu-latest";
    });
    expect(auditPackSmokeWindowsJob(weakened)).toContain(
      "runs on ubuntu-latest, not windows-latest",
    );
  });

  it("catches continue-on-error on the job", () => {
    const weakened = mutated((copy) => {
      copy["continue-on-error"] = true;
    });
    expect(auditPackSmokeWindowsJob(weakened)).toContain("the job sets continue-on-error");
  });

  it("catches continue-on-error on a single step", () => {
    const weakened = mutated((copy) => {
      const step = (copy.steps ?? []).find((candidate) => candidate.run?.includes("pack:smoke"));
      if (step) step["continue-on-error"] = true;
    });
    expect(auditPackSmokeWindowsJob(weakened).join("\n")).toMatch(/a step sets continue-on-error/);
  });

  it("catches a write permission being granted", () => {
    const weakened = mutated((copy) => {
      copy.permissions = { contents: "write" };
    });
    expect(auditPackSmokeWindowsJob(weakened)).toContain("grants contents: write");
  });

  it("catches an id-token permission being granted", () => {
    const weakened = mutated((copy) => {
      copy.permissions = { "id-token": "write" };
    });
    expect(auditPackSmokeWindowsJob(weakened)).toContain("grants id-token: write");
  });

  it("catches a publish command appearing in the job", () => {
    const weakened = mutated((copy) => {
      copy.steps = [...(copy.steps ?? []), { run: "npm publish --tag next" }];
    });
    expect(auditPackSmokeWindowsJob(weakened)).toContain(
      "runs a state-changing command: npm publish",
    );
  });

  it("catches the worktree cleanliness check being removed", () => {
    const weakened = mutated((copy) => {
      copy.steps = (copy.steps ?? []).filter(
        (step) => !step.run?.includes("git status --porcelain"),
      );
    });
    expect(auditPackSmokeWindowsJob(weakened)).toContain(
      "does not assert the worktree is left clean",
    );
  });

  it("catches the frozen-lockfile install being loosened", () => {
    const weakened = mutated((copy) => {
      for (const step of copy.steps ?? []) {
        if (step.run?.includes("pnpm install")) step.run = "pnpm install";
      }
    });
    expect(auditPackSmokeWindowsJob(weakened)).toContain(
      "does not install from the frozen lockfile",
    );
  });

  it("catches the pnpm selection check being dropped", () => {
    const weakened = mutated((copy) => {
      copy.steps = (copy.steps ?? []).filter(
        (step) => !step.run?.includes("check-pnpm-selection.mjs"),
      );
    });
    expect(auditPackSmokeWindowsJob(weakened)).toContain(
      "does not assert the resolved pnpm is the one packageManager names",
    );
  });

  it("catches fail-fast being left on, which would hide one floor's result", () => {
    const weakened = mutated((copy) => {
      copy.strategy = { ...copy.strategy, "fail-fast": true };
    });
    expect(auditPackSmokeWindowsJob(weakened)).toContain("does not set fail-fast: false");
  });

  it("catches an action pinned to a floating tag", () => {
    const weakened = mutated((copy) => {
      copy.steps = [...(copy.steps ?? []), { uses: "actions/checkout@v7" }];
    });
    expect(auditPackSmokeWindowsJob(weakened)).toContain(
      "action is not pinned to a full commit SHA: actions/checkout@v7",
    );
  });

  it("catches the job being deleted outright", () => {
    expect(auditPackSmokeWindowsJob(undefined)).toEqual(["the job does not exist"]);
  });
});
