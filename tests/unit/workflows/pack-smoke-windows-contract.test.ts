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
  // `unknown`, not `boolean`: `continue-on-error: ${{ true }}` is a string, and `if: ${{ false }}`
  // is a string too. Typing them as booleans is what let an expression form slip past a `=== true`.
  if?: unknown;
  "continue-on-error"?: unknown;
}

interface Job {
  name?: string;
  "runs-on"?: string;
  "timeout-minutes"?: number;
  if?: unknown;
  "continue-on-error"?: unknown;
  permissions?: Record<string, string>;
  strategy?: Record<string, unknown>;
  steps?: Step[];
}

interface Workflow {
  jobs: Record<string, Job>;
}

const workflow: Workflow = parse(readFileSync(resolve(root, ".github/workflows/ci.yml"), "utf8"));

const SUPPORTED_NODE_FLOORS = ["22.18.0", "24.11.0"];

/** The job's whole permission set: read the checkout, nothing else. */
const REQUIRED_PERMISSIONS: Record<string, string> = { contents: "read" };

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

  // The matrix is compared as a whole structure, not by looking for the two floors inside it.
  // `exclude: [{ node-version: 24.11.0 }]` leaves both floors in the array and runs one of them,
  // and an extra axis silently multiplies or reshapes the run.
  const strategy = job.strategy ?? {};
  const strategyKeys = Object.keys(strategy).sort();
  if (strategyKeys.join(",") !== "fail-fast,matrix") {
    failures.push(
      `strategy declares ${strategyKeys.join(", ") || "nothing"}, not exactly fail-fast and matrix`,
    );
  }
  // Literal `false`: `fail-fast: ${{ … }}` is a string, and a failure on one floor would then be
  // free to hide the other floor's result.
  if (strategy["fail-fast"] !== false) {
    failures.push(`fail-fast is ${JSON.stringify(strategy["fail-fast"])}, not literal false`);
  }
  const matrix = (strategy.matrix ?? {}) as Record<string, unknown>;
  const matrixKeys = Object.keys(matrix).sort();
  if (matrixKeys.join(",") !== "node-version") {
    failures.push(
      `matrix declares ${matrixKeys.join(", ") || "nothing"}, not exactly node-version`,
    );
  }
  const floors = matrix["node-version"];
  if (!Array.isArray(floors) || floors.some((floor) => typeof floor !== "string")) {
    failures.push(`matrix node-version is ${JSON.stringify(floors)}, not a list of versions`);
  } else if ([...floors].sort().join(",") !== [...SUPPORTED_NODE_FLOORS].sort().join(",")) {
    failures.push(
      `matrix node-version is ${floors.join(", ")}, not exactly ${SUPPORTED_NODE_FLOORS.join(", ")}`,
    );
  }

  // Every load-bearing command is compared exactly, after normalising the whitespace a YAML folded
  // scalar introduces — not by substring. `run.includes("pnpm pack:smoke")` is satisfied by
  // `echo "pnpm pack:smoke"`, by `pnpm pack:smoke || true`, and by a comment; all three leave the
  // step green while running nothing.
  //
  // Matching the command is still not enough on its own. A step carrying the exact command can be
  // skipped with `if: ${{ false }}`, have its failure ignored with `continue-on-error`, or be handed
  // to a `shell` that never runs it — `shell: echo {0}` prints the script instead. GitHub reports a
  // skipped job as a success, so each of those leaves a green required check over nothing. The step
  // is therefore located by its exact command and then checked for how it would run.
  const normalise = (run: string) => run.trim().replace(/\s+/g, " ");
  const stepsRunning = (command: string) =>
    steps.filter((step) => step.run !== undefined && normalise(step.run) === command);

  /** @param expectedShell  the `shell` the step must declare; `undefined` means the job default */
  const requires = (command: string, label: string, expectedShell?: string) => {
    const matching = stepsRunning(command);
    if (matching.length === 0) {
      failures.push(`does not run ${label}`);
      return;
    }
    // Two steps with the same command let an inert one sit beside a real one and satisfy a search.
    if (matching.length > 1) {
      failures.push(`runs ${label} in ${matching.length} steps, not exactly one`);
      return;
    }
    const [step] = matching;
    if (step.shell !== expectedShell) {
      failures.push(
        `${label} runs under ${step.shell ?? "the job default shell"}, not ${expectedShell ?? "the job default shell"}`,
      );
    }
  };

  requires("node scripts/check-pnpm-selection.mjs", "the pnpm selection check");
  requires("pnpm install --frozen-lockfile", "the frozen-lockfile install");
  // The packed smoke specifically: a unit-test run would exercise the workspace, not the artifact.
  requires("pnpm pack:smoke", "pnpm pack:smoke");
  // And the Windows-only branches the packed smoke drives but does not pin: `cmd.exe` quoting,
  // `PATHEXT` resolution, and which bin shim npm generated. Required *in addition to* the packed
  // smoke — the check above still stands on its own, so neither can be traded for the other.
  requires(
    "pnpm exec vitest run tests/unit/run-command.test.ts tests/unit/installed-cli-bin-path.test.ts",
    "the Windows-only runner and bin-resolution cases",
  );

  // The cleanliness check is two commands, in order, and nothing else: `git status --porcelain`
  // alone reports rather than fails, and `git diff --exit-code` alone misses an untracked file.
  const CLEAN_SCRIPT = ["git diff --exit-code", 'test -z "$(git status --porcelain)"'];
  const scriptOf = (step: Step) =>
    (step.run ?? "")
      .split("\n")
      .map(normalise)
      .filter((line) => line !== "");
  const cleanSteps = steps.filter((step) => scriptOf(step).join("\n") === CLEAN_SCRIPT.join("\n"));
  if (cleanSteps.length === 1) {
    if (cleanSteps[0].shell !== "bash") {
      failures.push(
        `worktree cleanliness check runs under ${cleanSteps[0].shell ?? "the default shell"}`,
      );
    }
  } else {
    // Name what is there, when something is: "missing" and "rewritten" are different mistakes.
    const rewritten = steps.find((step) => step.run?.includes("git status --porcelain"));
    failures.push(
      rewritten
        ? `worktree cleanliness check is not exactly ${CLEAN_SCRIPT.join(" then ")} (got: ${scriptOf(rewritten).join(" then ") || "nothing"})`
        : "does not assert the worktree is left clean",
    );
  }

  // A step that never runs, or whose failure is ignored, is the most invisible way this job rots.
  // Both properties are refused outright rather than checked for a value: this job needs no
  // condition and no tolerated failure, so any occurrence is a change that has to be argued for.
  if (Object.hasOwn(job, "if")) failures.push("the job is conditional");
  if (Object.hasOwn(job, "continue-on-error")) failures.push("the job sets continue-on-error");
  for (const step of steps) {
    const named = step.name ?? step.run ?? step.uses ?? "(unnamed)";
    if (Object.hasOwn(step, "if")) failures.push(`a step is conditional: ${named}`);
    if (Object.hasOwn(step, "continue-on-error")) {
      failures.push(`a step sets continue-on-error: ${named}`);
    }
  }

  // This job verifies; it must not be able to write anything, and must not be handed an OIDC
  // identity it could exchange for registry credentials.
  //
  // Checked as an exact set, not as "nothing declared is a write". Naming any job-level permission
  // is what sets every unnamed one to `none`, so an absent or empty block does not restrict the
  // token at all — it inherits the repository default. Rejecting only declared writes accepted
  // precisely the case that grants the most.
  if (job.permissions === undefined) {
    failures.push(
      "declares no permissions, so its token is whatever the repository default grants",
    );
  } else {
    const describe = (permissions: Record<string, string>) =>
      Object.entries(permissions)
        .map(([scope, level]) => `${scope}: ${level}`)
        .sort()
        .join(", ") || "{}";
    const actual = describe(job.permissions);
    const expected = describe(REQUIRED_PERMISSIONS);
    if (actual !== expected) failures.push(`grants ${actual}, not exactly ${expected}`);
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

/** Rewrite the first step whose `run` contains `needle`. */
const mutateRun = (needle: string, rewrite: (run: string) => string): Job =>
  mutated((copy) => {
    const step = (copy.steps ?? []).find((candidate) => candidate.run?.includes(needle));
    if (step?.run !== undefined) step.run = rewrite(step.run);
  });

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
    expect(auditPackSmokeWindowsJob(weakened)).toContain(
      "matrix node-version is 22.18.0, not exactly 22.18.0, 24.11.0",
    );
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

  it("catches the permissions block being removed entirely", () => {
    // The case the earlier "no declared write" rule accepted, and the one that grants the most.
    const weakened = mutated((copy) => {
      copy.permissions = undefined;
    });
    expect(auditPackSmokeWindowsJob(weakened)).toContain(
      "declares no permissions, so its token is whatever the repository default grants",
    );
  });

  it("catches an empty permissions block", () => {
    const weakened = mutated((copy) => {
      copy.permissions = {};
    });
    expect(auditPackSmokeWindowsJob(weakened)).toContain("grants {}, not exactly contents: read");
  });

  it("catches a write permission being granted", () => {
    const weakened = mutated((copy) => {
      copy.permissions = { contents: "write" };
    });
    expect(auditPackSmokeWindowsJob(weakened)).toContain(
      "grants contents: write, not exactly contents: read",
    );
  });

  it("catches an id-token permission being granted", () => {
    const weakened = mutated((copy) => {
      copy.permissions = { "id-token": "write" };
    });
    expect(auditPackSmokeWindowsJob(weakened)).toContain(
      "grants id-token: write, not exactly contents: read",
    );
  });

  it("catches an extra permission added beside the required one", () => {
    const weakened = mutated((copy) => {
      copy.permissions = { contents: "read", issues: "read" };
    });
    expect(auditPackSmokeWindowsJob(weakened)).toContain(
      "grants contents: read, issues: read, not exactly contents: read",
    );
  });

  it("catches the Windows-only runner cases being dropped", () => {
    const weakened = mutated((copy) => {
      copy.steps = (copy.steps ?? []).filter((step) => !step.run?.includes("vitest run"));
    });
    expect(auditPackSmokeWindowsJob(weakened)).toContain(
      "does not run the Windows-only runner and bin-resolution cases",
    );
  });

  it("catches one of the two Windows-only test files being dropped", () => {
    const weakened = mutateRun(
      "vitest run",
      () => "pnpm exec vitest run tests/unit/run-command.test.ts",
    );
    expect(auditPackSmokeWindowsJob(weakened)).toContain(
      "does not run the Windows-only runner and bin-resolution cases",
    );
  });

  it("catches the targeted tests being offered in place of the packed smoke", () => {
    // Both are required; neither can be traded for the other.
    const weakened = mutated((copy) => {
      copy.steps = (copy.steps ?? []).filter((step) => step.run?.trim() !== "pnpm pack:smoke");
    });
    expect(auditPackSmokeWindowsJob(weakened)).toContain("does not run pnpm pack:smoke");
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
      "does not run the frozen-lockfile install",
    );
  });

  it("catches the pnpm selection check being dropped", () => {
    const weakened = mutated((copy) => {
      copy.steps = (copy.steps ?? []).filter(
        (step) => !step.run?.includes("check-pnpm-selection.mjs"),
      );
    });
    expect(auditPackSmokeWindowsJob(weakened)).toContain("does not run the pnpm selection check");
  });

  it("catches fail-fast being left on, which would hide one floor's result", () => {
    const weakened = mutated((copy) => {
      copy.strategy = { ...copy.strategy, "fail-fast": true };
    });
    expect(auditPackSmokeWindowsJob(weakened)).toContain("fail-fast is true, not literal false");
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

/**
 * A step can keep its exact command and still never run it.
 *
 * GitHub reports a skipped job as a success, and a skipped job satisfies a required check — so
 * `if: ${{ false }}` on the job turns the whole matrix into a green check over nothing. The same
 * holds one level down for a step, for a `matrix.exclude` that removes a floor the array still
 * lists, for a `continue-on-error` written as an expression rather than a boolean, and for a
 * `shell` that prints the script instead of running it.
 */
describe("the Windows packed-CLI contract requires the job to actually execute", () => {
  const PACK_SMOKE = "pnpm pack:smoke";
  const TARGETED =
    "pnpm exec vitest run tests/unit/run-command.test.ts tests/unit/installed-cli-bin-path.test.ts";

  it.each([[false], ["${{ false }}"], [true], ["${{ github.event_name == 'push' }}"]])(
    "catches a job condition (%s)",
    (condition) => {
      const weakened = mutated((copy) => {
        copy.if = condition;
      });
      expect(auditPackSmokeWindowsJob(weakened)).toContain("the job is conditional");
    },
  );

  it.each([
    ["the checkout", (step: Step) => step.uses?.includes("checkout") === true],
    ["the packed smoke", (step: Step) => step.run?.trim() === PACK_SMOKE],
    ["the Windows-only cases", (step: Step) => step.run?.trim() === TARGETED],
    [
      "the cleanliness check",
      (step: Step) => step.run?.includes("git status --porcelain") === true,
    ],
  ])("catches a condition on %s step", (_label, matches) => {
    const weakened = mutated((copy) => {
      const step = (copy.steps ?? []).find((candidate) => matches(candidate));
      if (step) step.if = "${{ false }}";
    });
    expect(auditPackSmokeWindowsJob(weakened).join("\n")).toMatch(/a step is conditional/);
  });

  it("catches a Node floor being excluded while the array still lists it", () => {
    const weakened = mutated((copy) => {
      copy.strategy = { ...copy.strategy, exclude: [{ "node-version": "24.11.0" }] };
    });
    expect(auditPackSmokeWindowsJob(weakened)).toContain(
      "strategy declares exclude, fail-fast, matrix, not exactly fail-fast and matrix",
    );
  });

  it.each([
    ["exclude inside the matrix", { exclude: [{ "node-version": "24.11.0" }] }],
    ["include inside the matrix", { include: [{ "node-version": "20.0.0" }] }],
    ["an extra axis", { os: ["windows-latest", "ubuntu-latest"] }],
  ])("catches %s", (_label, extra) => {
    const weakened = mutated((copy) => {
      copy.strategy = {
        ...copy.strategy,
        matrix: { "node-version": [...SUPPORTED_NODE_FLOORS], ...extra },
      };
    });
    expect(auditPackSmokeWindowsJob(weakened).join("\n")).toMatch(
      /matrix declares .*, not exactly node-version/,
    );
  });

  it("catches a duplicated Node floor", () => {
    const weakened = mutated((copy) => {
      copy.strategy = { ...copy.strategy, matrix: { "node-version": ["22.18.0", "22.18.0"] } };
    });
    expect(auditPackSmokeWindowsJob(weakened).join("\n")).toMatch(
      /not exactly 22\.18\.0, 24\.11\.0/,
    );
  });

  it("catches a matrix supplied as an expression", () => {
    const weakened = mutated((copy) => {
      copy.strategy = {
        ...copy.strategy,
        matrix: { "node-version": "${{ fromJSON(env.FLOORS) }}" },
      };
    });
    expect(auditPackSmokeWindowsJob(weakened).join("\n")).toMatch(/not a list of versions/);
  });

  it("catches fail-fast supplied as an expression rather than literal false", () => {
    const weakened = mutated((copy) => {
      copy.strategy = { ...copy.strategy, "fail-fast": "${{ false }}" };
    });
    expect(auditPackSmokeWindowsJob(weakened).join("\n")).toMatch(/not literal false/);
  });

  it.each([[true], ["true"], ["${{ true }}"], ["${{ matrix.experimental }}"], [false]])(
    "catches continue-on-error on the job in any form (%s)",
    (value) => {
      // Checked for presence, not for a value: `=== true` passed every expression form.
      const weakened = mutated((copy) => {
        copy["continue-on-error"] = value;
      });
      expect(auditPackSmokeWindowsJob(weakened)).toContain("the job sets continue-on-error");
    },
  );

  it.each([[true], ["${{ true }}"], ["${{ matrix.experimental }}"]])(
    "catches continue-on-error on a step in any form (%s)",
    (value) => {
      const weakened = mutated((copy) => {
        const step = (copy.steps ?? []).find((candidate) => candidate.run?.trim() === PACK_SMOKE);
        if (step) step["continue-on-error"] = value;
      });
      expect(auditPackSmokeWindowsJob(weakened).join("\n")).toMatch(
        /a step sets continue-on-error/,
      );
    },
  );

  it.each([
    [PACK_SMOKE, "pnpm pack:smoke"],
    [TARGETED, "the Windows-only runner and bin-resolution cases"],
    ["pnpm install --frozen-lockfile", "the frozen-lockfile install"],
    ["node scripts/check-pnpm-selection.mjs", "the pnpm selection check"],
  ])("catches an inert shell on the step running %s", (command, label) => {
    // `shell: echo {0}` prints the script; the step succeeds and the command never runs.
    const weakened = mutated((copy) => {
      const step = (copy.steps ?? []).find((candidate) => candidate.run?.trim() === command);
      if (step) step.shell = "echo {0}";
    });
    expect(auditPackSmokeWindowsJob(weakened)).toContain(
      `${label} runs under echo {0}, not the job default shell`,
    );
  });

  it("catches an inert shell on the cleanliness check", () => {
    const weakened = mutated((copy) => {
      const step = (copy.steps ?? []).find((candidate) =>
        candidate.run?.includes("git status --porcelain"),
      );
      if (step) step.shell = "echo {0}";
    });
    expect(auditPackSmokeWindowsJob(weakened)).toContain(
      "worktree cleanliness check runs under echo {0}",
    );
  });
});

/**
 * A step can be made inert without being removed.
 *
 * Wrapping a command in `echo`, appending `|| true`, or ending the script with `exit 0` all leave
 * the step green and the step list unchanged — and every one of them satisfies a substring check
 * for the command it neutralises. These are the mutations a contract built on `includes` accepts,
 * which is why the commands above are compared exactly.
 */
describe("the Windows packed-CLI contract rejects an inert command", () => {
  const RUNNER_CASES =
    "pnpm exec vitest run tests/unit/run-command.test.ts tests/unit/installed-cli-bin-path.test.ts";
  const MISSING_RUNNER_CASES = "does not run the Windows-only runner and bin-resolution cases";

  it.each([
    ["echoed instead of run", (run: string) => `echo "${run}"`],
    ["neutralised with || true", (run: string) => `${run} || true`],
    ["neutralised with ; exit 0", (run: string) => `${run}; exit 0`],
    ["commented out", (run: string) => `# ${run}`],
    ["softened with --passWithNoTests", (run: string) => `${run} --passWithNoTests`],
  ])("catches the Windows-only cases being %s", (_label, rewrite) => {
    const weakened = mutateRun(RUNNER_CASES, rewrite);
    expect(auditPackSmokeWindowsJob(weakened)).toContain(MISSING_RUNNER_CASES);
  });

  it.each([
    ["echoed instead of run", (run: string) => `echo "${run}"`],
    ["neutralised with || true", (run: string) => `${run} || true`],
  ])("catches the packed smoke being %s", (_label, rewrite) => {
    const weakened = mutateRun("pnpm pack:smoke", rewrite);
    expect(auditPackSmokeWindowsJob(weakened)).toContain("does not run pnpm pack:smoke");
  });

  it("catches the pnpm selection check being echoed", () => {
    const weakened = mutateRun("check-pnpm-selection.mjs", (run) => `echo "${run}"`);
    expect(auditPackSmokeWindowsJob(weakened)).toContain("does not run the pnpm selection check");
  });

  it("catches the frozen install being neutralised", () => {
    const weakened = mutateRun("pnpm install --frozen-lockfile", (run) => `${run} || true`);
    expect(auditPackSmokeWindowsJob(weakened)).toContain(
      "does not run the frozen-lockfile install",
    );
  });

  it.each([
    [
      "echoed instead of run",
      'echo "git diff --exit-code"\necho "test -z \\"$(git status --porcelain)\\""',
    ],
    [
      "given || true on the diff",
      'git diff --exit-code || true\ntest -z "$(git status --porcelain)"',
    ],
    [
      "given || true on the status",
      'git diff --exit-code\ntest -z "$(git status --porcelain)" || true',
    ],
    ["reversed in order", 'test -z "$(git status --porcelain)"\ngit diff --exit-code'],
    ["ended with exit 0", 'git diff --exit-code\ntest -z "$(git status --porcelain)"\nexit 0'],
    ["reduced to the diff alone", "git diff --exit-code"],
  ])("catches the worktree cleanliness check being %s", (_label, replacement) => {
    const weakened = mutateRun("git status --porcelain", () => replacement as string);
    expect(auditPackSmokeWindowsJob(weakened).join("\n")).toMatch(
      /worktree cleanliness check is not exactly|does not assert the worktree is left clean/,
    );
  });

  it("catches a duplicate step carrying the same command", () => {
    // An inert step sitting beside a real one satisfies any search that stops at the first match.
    const weakened = mutated((copy) => {
      copy.steps = [...(copy.steps ?? []), { run: "pnpm pack:smoke", if: "${{ false }}" }];
    });
    expect(auditPackSmokeWindowsJob(weakened)).toContain(
      "runs pnpm pack:smoke in 2 steps, not exactly one",
    );
  });

  it("catches the cleanliness check being moved off bash", () => {
    const weakened = mutated((copy) => {
      const step = (copy.steps ?? []).find((candidate) =>
        candidate.run?.includes("git status --porcelain"),
      );
      if (step) step.shell = "pwsh";
    });
    expect(auditPackSmokeWindowsJob(weakened)).toContain(
      "worktree cleanliness check runs under pwsh",
    );
  });
});
