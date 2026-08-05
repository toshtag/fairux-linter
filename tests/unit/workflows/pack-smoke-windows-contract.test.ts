import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

/**
 * What the Windows packed-CLI job has to keep doing.
 *
 * A platform matrix decays quietly, and this job is the only place the published CLI is ever
 * installed and run on Windows — so a check that has gone hollow is indistinguishable, from the
 * outside, from the coverage existing. Every earlier version of this file checked a growing list of
 * individual fields, and each review round found another field that decided whether the job meant
 * anything and was not on the list: `continue-on-error` written as an expression, a job-level `if`,
 * a `matrix.exclude` removing a floor the array still lists, a `shell` that prints the script, a
 * `setup-node` pinned to one floor while the matrix advertises two, a `checkout` of `main`.
 *
 * So the job is no longer audited field by field. It is projected into a canonical shape — every
 * key it declares, every step in order, with `run` scripts whitespace-normalised — and compared
 * against the shape this repository intends. Anything the workflow adds, removes, reorders, or
 * changes is a difference, whether or not anyone thought of it in advance. What remains as separate
 * rules are the things a shape comparison cannot express: no secret anywhere in the subtree, no
 * state-changing command, and every action pinned to a full commit SHA.
 *
 * The mutation cases below drive the same rules with jobs the workflow does not contain. A contract
 * test that only ever sees the passing input proves that the input passes, not that anything else
 * would fail.
 */

const root = resolve(import.meta.dirname, "../../..");

type Step = Record<string, unknown>;
type Job = Record<string, unknown>;

interface Workflow {
  defaults?: unknown;
  env?: unknown;
  jobs: Record<string, Job>;
}

const workflow: Workflow = parse(
  readFileSync(resolve(root, ".github/workflows/release-contract.yml"), "utf8"),
);

const CHECKOUT = "actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0";
const PNPM_SETUP = "pnpm/action-setup@fc06bc1257f339d1d5d8b3a19a8cae5388b55320";
const SETUP_NODE = "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020";

const TARGETED_TESTS =
  "pnpm exec vitest run tests/unit/run-command.test.ts tests/unit/installed-cli-bin-path.test.ts";

/**
 * The job, exactly.
 *
 * Read it as the answer to "what runs, on what, from what checkout, under which shell". The
 * checkout is unqualified, so GitHub selects the commit for the event: the pull request's *merge*
 * commit on `pull_request` — the integration with the base branch, not the head alone — and the
 * pushed commit on `push`. `setup-node` binds to the matrix floor rather than a literal, and the
 * only `shell` in the job is the `bash` the cleanliness check needs.
 */
const EXPECTED_JOB: Job = {
  name: "pack-smoke-windows (Node ${{ matrix.node-version }})",
  "runs-on": "windows-latest",
  "timeout-minutes": 25,
  permissions: { contents: "read" },
  strategy: { "fail-fast": false, matrix: { "node-version": ["22.18.0", "24.11.0"] } },
  steps: [
    { uses: CHECKOUT },
    { uses: PNPM_SETUP },
    { uses: SETUP_NODE, with: { "node-version": "${{ matrix.node-version }}", cache: "pnpm" } },
    { run: "node scripts/check-pnpm-selection.mjs" },
    { run: "pnpm install --frozen-lockfile" },
    { name: "Run the Windows-only runner and bin-resolution cases", run: TARGETED_TESTS },
    { run: "pnpm pack:smoke" },
    {
      name: "Assert the worktree is clean afterwards",
      shell: "bash",
      run: 'git diff --exit-code\ntest -z "$(git status --porcelain)"',
    },
  ],
};

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
 * A `run` script with its irrelevant whitespace removed and its **line boundaries kept**.
 *
 * In a `run`, a newline is not spacing: each line is a separate command in the same shell. The
 * worktree check is two of them, and `git status --porcelain` alone reports instead of failing —
 * so collapsing the newline into a space turns a two-statement script into one statement that
 * means something else. Flattening every whitespace run, as this did, made a `>` folded scalar and
 * a `|` literal one produce the same canonical value, and the contract could not tell them apart.
 *
 * Spacing *within* a line is still collapsed: YAML folding and indentation move it around without
 * changing what runs.
 */
const normalise = (run: string) =>
  run
    .trim()
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/[ \t]+/g, " "))
    .filter((line) => line !== "")
    .join("\n");

/** A step with its script normalised as above. */
const canonicalStep = (step: Step): Step =>
  typeof step.run === "string" ? { ...step, run: normalise(step.run) } : { ...step };

const canonicalJob = (job: Job): Job => ({
  ...job,
  steps: Array.isArray(job.steps) ? (job.steps as Step[]).map(canonicalStep) : job.steps,
});

const describeValue = (value: unknown) => (value === undefined ? "absent" : JSON.stringify(value));

/**
 * Report where `actual` differs from `expected`, by path.
 *
 * A bare `toEqual` would say the job is wrong without saying which field decides it, and the
 * mutation cases below are only meaningful if each names the thing it broke.
 */
function shapeFailures(actual: unknown, expected: unknown, path: string): string[] {
  if (Array.isArray(expected) || Array.isArray(actual)) {
    if (!Array.isArray(actual) || !Array.isArray(expected)) {
      return [`${path} is ${describeValue(actual)}, expected ${describeValue(expected)}`];
    }
    if (actual.length !== expected.length) {
      return [`${path} has ${actual.length} entries, expected ${expected.length}`];
    }
    return expected.flatMap((entry, index) =>
      shapeFailures(actual[index], entry, `${path}[${index}]`),
    );
  }

  const isObject = (value: unknown) =>
    typeof value === "object" && value !== null && !Array.isArray(value);
  if (isObject(expected) && isObject(actual)) {
    const keys = [
      ...new Set([...Object.keys(expected as object), ...Object.keys(actual as object)]),
    ].sort();
    return keys.flatMap((key) =>
      shapeFailures(
        (actual as Record<string, unknown>)[key],
        (expected as Record<string, unknown>)[key],
        path === "" ? key : `${path}.${key}`,
      ),
    );
  }

  return actual === expected
    ? []
    : [`${path} is ${describeValue(actual)}, expected ${describeValue(expected)}`];
}

/** Every string anywhere under a value, for the scans a shape comparison cannot express. */
function strings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(strings);
  if (typeof value === "object" && value !== null) return Object.values(value).flatMap(strings);
  return [];
}

/**
 * @returns the ways `job` falls short of the Windows packed-CLI contract; empty means it holds
 */
function auditPackSmokeWindowsJob(job: Job | undefined, context: Workflow = workflow): string[] {
  if (!job) return ["the job does not exist"];

  // The shape first: order, count, every key, every value.
  const failures = shapeFailures(canonicalJob(job), EXPECTED_JOB, "");

  // A workflow-level default is inherited by this job without appearing in it, so a `shell` or a
  // `working-directory` set there would change what these steps do while the job reads unchanged.
  for (const key of ["defaults", "env"] as const) {
    if (context[key] !== undefined) {
      failures.push(`the workflow declares ${key}, which this job would inherit`);
    }
  }

  const text = strings(job);
  // Defence in depth: the shape above already refuses `env` on the job and on every step, so there
  // is nowhere left to put one — but a secret reaching a verification job is worth naming directly.
  if (text.some((value) => value.includes("${{ secrets."))) {
    failures.push("the job references a secret");
  }
  for (const value of text) {
    for (const command of PUBLISHING_COMMANDS) {
      if (value.includes(command)) failures.push(`runs a state-changing command: ${command}`);
    }
  }
  for (const step of (job.steps ?? []) as Step[]) {
    if (typeof step.uses === "string" && !/@[0-9a-f]{40}$/.test(step.uses)) {
      failures.push(`action is not pinned to a full commit SHA: ${step.uses}`);
    }
  }

  return failures;
}

/**
 * The job every case below reads.
 *
 * Asserted here rather than at each use: a workflow that stopped declaring it should fail loudly
 * once, not produce thirty assertions about `undefined`.
 */
const job = ((): Job => {
  const found = workflow.jobs["pack-smoke-windows"];
  if (!found) throw new Error("release-contract.yml no longer declares pack-smoke-windows");
  return found;
})();

/** A structural copy of the real job, for a mutation to be applied to. */
const mutated = (change: (copy: Job) => void): Job => {
  const copy = structuredClone(job);
  change(copy);
  return copy;
};

/** Rewrite the step at `index`. */
const mutateStep = (index: number, change: (step: Step) => void): Job =>
  mutated((copy) => {
    const step = (copy.steps as Step[])[index];
    if (!step) throw new Error(`the job has no step ${index}`);
    change(step);
  });

/** Rewrite the first step whose `run` contains `needle`. */
const mutateRun = (needle: string, rewrite: (run: string) => string): Job =>
  mutated((copy) => {
    const step = (copy.steps as Step[]).find(
      (candidate) => typeof candidate.run === "string" && candidate.run.includes(needle),
    );
    if (step) step.run = rewrite(step.run as string);
  });

const STEP = {
  checkout: 0,
  pnpm: 1,
  node: 2,
  selection: 3,
  install: 4,
  targeted: 5,
  smoke: 6,
  clean: 7,
} as const;

describe("CI Windows packed-CLI job", () => {
  it("matches the intended execution shape exactly", () => {
    expect(auditPackSmokeWindowsJob(job)).toEqual([]);
  });

  it("declares nothing beyond the shape, so nothing arrives unexamined", () => {
    expect(Object.keys(job).sort()).toEqual(Object.keys(EXPECTED_JOB).sort());
  });

  it("keeps the Linux pack smoke and the Windows config job alongside it", () => {
    // This job adds a platform; it replaces neither the Linux matrix nor the workspace-level
    // Windows config checks.
    expect(workflow.jobs["pack-smoke"]).toBeDefined();
    expect(workflow.jobs["config-windows"]).toBeDefined();
  });

  it("pins the same action versions the Linux pack smoke uses", () => {
    // Two jobs installing the same lockfile with different action revisions is a difference the
    // matrix would attribute to the platform.
    const usesOf = (name: string) =>
      ((workflow.jobs[name]?.steps ?? []) as Step[]).flatMap((step) =>
        typeof step.uses === "string" ? [step.uses] : [],
      );

    expect(usesOf("pack-smoke-windows")).toEqual(usesOf("pack-smoke"));
  });
});

describe("the contract catches a job that would run something else", () => {
  it("catches the job being deleted outright", () => {
    expect(auditPackSmokeWindowsJob(undefined)).toEqual(["the job does not exist"]);
  });

  it("catches the job being moved off Windows", () => {
    const weakened = mutated((copy) => {
      copy["runs-on"] = "ubuntu-latest";
    });
    expect(auditPackSmokeWindowsJob(weakened)).toContain(
      'runs-on is "ubuntu-latest", expected "windows-latest"',
    );
  });

  it("catches a checkout of another ref", () => {
    // A pull-request check that verifies `main` is green about code the PR does not contain.
    const weakened = mutateStep(STEP.checkout, (step) => {
      step.with = { ref: "main" };
    });
    expect(auditPackSmokeWindowsJob(weakened)).toContain(
      'steps[0].with is {"ref":"main"}, expected absent',
    );
  });

  it("catches a sparse checkout", () => {
    const weakened = mutateStep(STEP.checkout, (step) => {
      step.with = { "sparse-checkout": "apps/cli" };
    });
    expect(auditPackSmokeWindowsJob(weakened).join("\n")).toMatch(/steps\[0\]\.with is /);
  });

  it("catches setup-node pinned to one floor while the matrix advertises two", () => {
    // The job name would still read "Node 24.11.0" on both runs.
    const weakened = mutateStep(STEP.node, (step) => {
      step.with = { "node-version": "22.18.0", cache: "pnpm" };
    });
    expect(auditPackSmokeWindowsJob(weakened)).toContain(
      'steps[2].with.node-version is "22.18.0", expected "${{ matrix.node-version }}"',
    );
  });

  it("catches setup-node reading a version file instead of the matrix", () => {
    const weakened = mutateStep(STEP.node, (step) => {
      step.with = { "node-version-file": ".nvmrc", cache: "pnpm" };
    });
    const failures = auditPackSmokeWindowsJob(weakened).join("\n");
    expect(failures).toMatch(/steps\[2\]\.with\.node-version is absent/);
    expect(failures).toMatch(/steps\[2\]\.with\.node-version-file is/);
  });

  it("catches an extra setup-node input", () => {
    const weakened = mutateStep(STEP.node, (step) => {
      step.with = { ...(step.with as object), "check-latest": true };
    });
    expect(auditPackSmokeWindowsJob(weakened)).toContain(
      "steps[2].with.check-latest is true, expected absent",
    );
  });

  it("catches the pnpm cache being dropped", () => {
    const weakened = mutateStep(STEP.node, (step) => {
      step.with = { "node-version": "${{ matrix.node-version }}" };
    });
    expect(auditPackSmokeWindowsJob(weakened)).toContain(
      'steps[2].with.cache is absent, expected "pnpm"',
    );
  });
});

describe("the contract catches a job that would not run at all", () => {
  it.each([[false], ["${{ false }}"], [true]])("catches a job condition (%s)", (condition) => {
    // GitHub reports a skipped job as a success, and a skipped job satisfies a required check.
    const weakened = mutated((copy) => {
      copy.if = condition;
    });
    expect(auditPackSmokeWindowsJob(weakened)).toContain(
      `if is ${JSON.stringify(condition)}, expected absent`,
    );
  });

  it.each([
    ["the checkout", STEP.checkout],
    ["the packed smoke", STEP.smoke],
    ["the Windows-only cases", STEP.targeted],
    ["the cleanliness check", STEP.clean],
  ])("catches a condition on %s step", (_label, index) => {
    const weakened = mutateStep(index, (step) => {
      step.if = "${{ false }}";
    });
    expect(auditPackSmokeWindowsJob(weakened)).toContain(
      `steps[${index}].if is "\${{ false }}", expected absent`,
    );
  });

  it.each([[true], ["true"], ["${{ true }}"], ["${{ matrix.experimental }}"], [false]])(
    "catches continue-on-error on the job in any form (%s)",
    (value) => {
      // Checked as a shape difference, not against `true`: every expression form is a string.
      const weakened = mutated((copy) => {
        copy["continue-on-error"] = value;
      });
      expect(auditPackSmokeWindowsJob(weakened)).toContain(
        `continue-on-error is ${JSON.stringify(value)}, expected absent`,
      );
    },
  );

  it.each([[true], ["${{ true }}"], ["${{ matrix.experimental }}"]])(
    "catches continue-on-error on a step in any form (%s)",
    (value) => {
      const weakened = mutateStep(STEP.smoke, (step) => {
        step["continue-on-error"] = value;
      });
      expect(auditPackSmokeWindowsJob(weakened)).toContain(
        `steps[6].continue-on-error is ${JSON.stringify(value)}, expected absent`,
      );
    },
  );

  it("catches a job-level default shell", () => {
    // Changes what every `run` step does without touching a single `run`.
    const weakened = mutated((copy) => {
      copy.defaults = { run: { shell: "echo {0}" } };
    });
    expect(auditPackSmokeWindowsJob(weakened).join("\n")).toMatch(/^defaults is /m);
  });

  it("catches a job-level default working directory", () => {
    const weakened = mutated((copy) => {
      copy.defaults = { run: { "working-directory": "apps/cli" } };
    });
    expect(auditPackSmokeWindowsJob(weakened).join("\n")).toMatch(/^defaults is /m);
  });

  it.each([["defaults"], ["env"]])("catches a workflow-level %s this job would inherit", (key) => {
    const context: Workflow = { ...workflow, [key]: { run: { shell: "echo {0}" } } };
    expect(auditPackSmokeWindowsJob(job, context)).toContain(
      `the workflow declares ${key}, which this job would inherit`,
    );
  });

  it.each([
    ["pnpm pack:smoke", STEP.smoke],
    ["the Windows-only cases", STEP.targeted],
    ["the frozen install", STEP.install],
    ["the pnpm selection check", STEP.selection],
  ])("catches an inert shell on %s", (_label, index) => {
    // `shell: echo {0}` prints the script; the step succeeds and the command never runs.
    const weakened = mutateStep(index, (step) => {
      step.shell = "echo {0}";
    });
    expect(auditPackSmokeWindowsJob(weakened)).toContain(
      `steps[${index}].shell is "echo {0}", expected absent`,
    );
  });

  it("catches the cleanliness check losing its bash shell", () => {
    const weakened = mutateStep(STEP.clean, (step) => {
      step.shell = undefined;
    });
    expect(auditPackSmokeWindowsJob(weakened)).toContain(
      'steps[7].shell is absent, expected "bash"',
    );
  });

  it("catches a working directory on the packed smoke", () => {
    const weakened = mutateStep(STEP.smoke, (step) => {
      step["working-directory"] = "apps/cli";
    });
    expect(auditPackSmokeWindowsJob(weakened)).toContain(
      'steps[6].working-directory is "apps/cli", expected absent',
    );
  });

  it("catches a step-level env", () => {
    const weakened = mutateStep(STEP.smoke, (step) => {
      step.env = { NPM_TOKEN: "${{ secrets.NPM_TOKEN }}" };
    });
    const failures = auditPackSmokeWindowsJob(weakened);
    expect(failures.join("\n")).toMatch(/steps\[6\]\.env is /);
    expect(failures).toContain("the job references a secret");
  });

  it("catches a job-level env carrying a secret", () => {
    const weakened = mutated((copy) => {
      copy.env = { NPM_TOKEN: "${{ secrets.NPM_TOKEN }}" };
    });
    const failures = auditPackSmokeWindowsJob(weakened);
    expect(failures.join("\n")).toMatch(/^env is /m);
    expect(failures).toContain("the job references a secret");
  });

  it.each([["environment"], ["needs"], ["concurrency"], ["container"]])(
    "catches a %s being added to the job",
    (key) => {
      const weakened = mutated((copy) => {
        copy[key] = key === "needs" ? ["verify"] : "publish";
      });
      expect(auditPackSmokeWindowsJob(weakened).join("\n")).toMatch(new RegExp(`^${key} is `, "m"));
    },
  );
});

describe("the contract catches a weakened matrix or timeout", () => {
  it("catches a dropped Node floor", () => {
    const weakened = mutated((copy) => {
      (copy.strategy as Job).matrix = { "node-version": ["22.18.0"] };
    });
    expect(auditPackSmokeWindowsJob(weakened)).toContain(
      "strategy.matrix.node-version has 1 entries, expected 2",
    );
  });

  it("catches a Node floor being excluded while the array still lists it", () => {
    const weakened = mutated((copy) => {
      (copy.strategy as Job).exclude = [{ "node-version": "24.11.0" }];
    });
    expect(auditPackSmokeWindowsJob(weakened).join("\n")).toMatch(/strategy\.exclude is /);
  });

  it.each([
    ["exclude inside the matrix", { exclude: [{ "node-version": "24.11.0" }] }],
    ["include inside the matrix", { include: [{ "node-version": "20.0.0" }] }],
    ["an extra axis", { os: ["windows-latest"] }],
  ])("catches %s", (_label, extra) => {
    const weakened = mutated((copy) => {
      (copy.strategy as Job).matrix = { "node-version": ["22.18.0", "24.11.0"], ...extra };
    });
    expect(auditPackSmokeWindowsJob(weakened).join("\n")).toMatch(/strategy\.matrix\.\w+ is /);
  });

  it("catches a matrix supplied as an expression", () => {
    const weakened = mutated((copy) => {
      (copy.strategy as Job).matrix = { "node-version": "${{ fromJSON(env.FLOORS) }}" };
    });
    expect(auditPackSmokeWindowsJob(weakened).join("\n")).toMatch(
      /strategy\.matrix\.node-version is /,
    );
  });

  it.each([[true], ["${{ false }}"]])("catches fail-fast being %s", (value) => {
    const weakened = mutated((copy) => {
      (copy.strategy as Job)["fail-fast"] = value;
    });
    expect(auditPackSmokeWindowsJob(weakened)).toContain(
      `strategy.fail-fast is ${JSON.stringify(value)}, expected false`,
    );
  });

  it("catches the timeout being removed", () => {
    const weakened = mutated((copy) => {
      copy["timeout-minutes"] = undefined;
    });
    expect(auditPackSmokeWindowsJob(weakened)).toContain("timeout-minutes is absent, expected 25");
  });

  it("catches the timeout being changed", () => {
    const weakened = mutated((copy) => {
      copy["timeout-minutes"] = 24;
    });
    expect(auditPackSmokeWindowsJob(weakened)).toContain("timeout-minutes is 24, expected 25");
  });

  it("catches the job name losing its matrix floor", () => {
    const weakened = mutated((copy) => {
      copy.name = "pack-smoke-windows";
    });
    expect(auditPackSmokeWindowsJob(weakened).join("\n")).toMatch(/^name is /m);
  });

  it.each([
    ["the permissions block being removed", undefined],
    ["an empty permissions block", {}],
    ["a write permission", { contents: "write" }],
    ["an id-token permission", { "id-token": "write" }],
    ["an extra permission", { contents: "read", issues: "read" }],
  ])("catches %s", (_label, permissions) => {
    const weakened = mutated((copy) => {
      copy.permissions = permissions;
    });
    expect(auditPackSmokeWindowsJob(weakened).join("\n")).toMatch(/^permissions/m);
  });
});

describe("the contract catches an inert or misplaced command", () => {
  it.each([
    ["echoed instead of run", (run: string) => `echo "${run}"`],
    ["neutralised with || true", (run: string) => `${run} || true`],
    ["neutralised with ; exit 0", (run: string) => `${run}; exit 0`],
    ["commented out", (run: string) => `# ${run}`],
    ["softened with --passWithNoTests", (run: string) => `${run} --passWithNoTests`],
  ])("catches the Windows-only cases being %s", (_label, rewrite) => {
    const weakened = mutateRun(TARGETED_TESTS, rewrite);
    expect(auditPackSmokeWindowsJob(weakened).join("\n")).toMatch(/^steps\[5\]\.run is /m);
  });

  it.each([
    ["echoed instead of run", (run: string) => `echo "${run}"`],
    ["neutralised with || true", (run: string) => `${run} || true`],
  ])("catches the packed smoke being %s", (_label, rewrite) => {
    const weakened = mutateRun("pnpm pack:smoke", rewrite);
    expect(auditPackSmokeWindowsJob(weakened).join("\n")).toMatch(/^steps\[6\]\.run is /m);
  });

  it("catches the pnpm selection check being echoed", () => {
    const weakened = mutateRun("check-pnpm-selection.mjs", (run) => `echo "${run}"`);
    expect(auditPackSmokeWindowsJob(weakened).join("\n")).toMatch(/^steps\[3\]\.run is /m);
  });

  it("catches the frozen install being neutralised", () => {
    const weakened = mutateRun("pnpm install --frozen-lockfile", (run) => `${run} || true`);
    expect(auditPackSmokeWindowsJob(weakened).join("\n")).toMatch(/^steps\[4\]\.run is /m);
  });

  it("catches one of the two Windows-only test files being dropped", () => {
    const weakened = mutateRun(
      TARGETED_TESTS,
      () => "pnpm exec vitest run tests/unit/run-command.test.ts",
    );
    expect(auditPackSmokeWindowsJob(weakened).join("\n")).toMatch(/^steps\[5\]\.run is /m);
  });

  it.each([
    ["echoed instead of run", 'echo "git diff --exit-code"\necho "git status --porcelain"'],
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
    ["reduced to the status alone", 'test -z "$(git status --porcelain)"'],
  ])("catches the worktree cleanliness check being %s", (_label, replacement) => {
    const weakened = mutateStep(STEP.clean, (step) => {
      step.run = replacement;
    });
    expect(auditPackSmokeWindowsJob(weakened).join("\n")).toMatch(/^steps\[7\]\.run is /m);
  });

  it.each([
    [
      "folded onto one line, as a `>` scalar would",
      'git diff --exit-code test -z "$(git status --porcelain)"',
    ],
    [
      "joined with a semicolon instead of a newline",
      'git diff --exit-code; test -z "$(git status --porcelain)"',
    ],
    [
      "given a third command",
      'git diff --exit-code\ntest -z "$(git status --porcelain)"\ngit clean -n',
    ],
  ])("catches the two-command worktree check being %s", (_label, replacement) => {
    // A newline in a `run` is a statement boundary, not spacing: one line here means one command,
    // and `git status --porcelain` on its own reports rather than fails.
    const weakened = mutateStep(STEP.clean, (step) => {
      step.run = replacement;
    });
    expect(auditPackSmokeWindowsJob(weakened).join("\n")).toMatch(/^steps\[7\]\.run is /m);
  });

  it("still allows spacing a single-line command differently", () => {
    // YAML folding and indentation move spaces around without changing what runs.
    const weakened = mutateStep(STEP.smoke, (step) => {
      step.run = "  pnpm   pack:smoke  ";
    });
    expect(auditPackSmokeWindowsJob(weakened)).toEqual([]);
  });

  it("catches an extra step being inserted", () => {
    const weakened = mutated((copy) => {
      copy.steps = [...(copy.steps as Step[]), { run: "echo done" }];
    });
    expect(auditPackSmokeWindowsJob(weakened)).toContain("steps has 9 entries, expected 8");
  });

  it("catches a required step being removed", () => {
    const weakened = mutated((copy) => {
      copy.steps = (copy.steps as Step[]).filter((_step, index) => index !== STEP.node);
    });
    expect(auditPackSmokeWindowsJob(weakened)).toContain("steps has 7 entries, expected 8");
  });

  it("catches a duplicated setup-node", () => {
    const weakened = mutated((copy) => {
      const steps = copy.steps as Step[];
      copy.steps = [...steps, steps[STEP.node]];
    });
    expect(auditPackSmokeWindowsJob(weakened)).toContain("steps has 9 entries, expected 8");
  });

  it("catches the required steps being reordered", () => {
    // The packed smoke before the install would run against whatever the checkout happened to have.
    const weakened = mutated((copy) => {
      const steps = copy.steps as Step[];
      copy.steps = [
        ...steps.slice(0, STEP.install),
        steps[STEP.smoke],
        steps[STEP.install],
        ...steps.slice(STEP.targeted, STEP.smoke),
        ...steps.slice(STEP.clean),
      ];
    });
    expect(auditPackSmokeWindowsJob(weakened).join("\n")).toMatch(/^steps\[4\]\.run is /m);
  });

  it("catches a publish command appearing in the job", () => {
    const weakened = mutated((copy) => {
      copy.steps = [...(copy.steps as Step[]), { run: "npm publish --tag next" }];
    });
    expect(auditPackSmokeWindowsJob(weakened)).toContain(
      "runs a state-changing command: npm publish",
    );
  });

  it("catches an action pinned to a floating tag", () => {
    const weakened = mutateStep(STEP.checkout, (step) => {
      step.uses = "actions/checkout@v7";
    });
    expect(auditPackSmokeWindowsJob(weakened)).toContain(
      "action is not pinned to a full commit SHA: actions/checkout@v7",
    );
  });
});
