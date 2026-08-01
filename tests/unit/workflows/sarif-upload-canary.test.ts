import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

/**
 * Pins the SARIF upload canary workflow to its boundary.
 *
 * This is the only workflow in the repository that writes to code scanning and the only one that
 * deletes anything. Both are irreversible by rerunning, so what matters here is not what it does
 * but what it cannot do: run without a human dispatching it, hold a token that could push, or reach
 * a ref other than the canary's.
 *
 * The refusals themselves live in `sarif-canary-contract.mjs` and are covered by
 * `tests/unit/sarif-canary-contract.test.ts`. What this file holds is that the workflow actually
 * routes through them.
 */

const root = resolve(import.meta.dirname, "../../..");

interface Step {
  name?: string;
  run?: string;
  uses?: string;
  if?: string;
  with?: Record<string, unknown>;
}
interface Job {
  permissions?: Record<string, string>;
  env?: Record<string, string>;
  steps?: Step[];
}
interface Workflow {
  on?: Record<string, unknown>;
  permissions?: Record<string, string>;
  concurrency?: { group?: string; "cancel-in-progress"?: boolean };
  jobs: Record<string, Job>;
}

const text = readFileSync(resolve(root, ".github/workflows/sarif-upload-canary.yml"), "utf8");
const parsed = parse(text) as Workflow;
const steps = Object.values(parsed.jobs).flatMap((job) => job.steps ?? []);
const runs = steps.map((step) => step.run ?? "").join("\n");

describe("sarif-upload-canary.yml is dispatched, never triggered", () => {
  it("runs only on workflow_dispatch", () => {
    // A `push` or `pull_request` trigger would upload real analyses on someone else's change, and
    // a `schedule` would keep recreating what the last cleanup deleted.
    expect(Object.keys(parsed.on ?? {})).toEqual(["workflow_dispatch"]);
  });

  it("requires the ref and both commits, and offers only two modes", () => {
    const inputs = (parsed.on?.workflow_dispatch as { inputs?: Record<string, Step> })?.inputs;
    expect(Object.keys(inputs ?? {}).sort()).toEqual([
      "canary_ref",
      "mode",
      "sha_after",
      "sha_before",
    ]);
    for (const name of ["canary_ref", "sha_before", "sha_after", "mode"]) {
      expect((inputs?.[name] as { required?: boolean })?.required, name).toBe(true);
    }
    expect((inputs?.mode as { options?: string[] })?.options).toEqual(["observe", "cleanup"]);
  });

  it("serialises runs against one analysis set", () => {
    // Two runs would each observe the other's uploads, and the second one's cleanup would delete
    // evidence the first had not recorded.
    expect(parsed.concurrency?.group).toBe("sarif-upload-canary");
    expect(parsed.concurrency?.["cancel-in-progress"]).toBe(false);
  });
});

describe("sarif-upload-canary.yml privilege boundary", () => {
  it("holds exactly contents: read and security-events: write", () => {
    expect(parsed.permissions).toEqual({ contents: "read", "security-events": "write" });
    for (const [name, job] of Object.entries(parsed.jobs)) {
      expect(job.permissions, `${name} must not widen the workflow permissions`).toBeUndefined();
    }
  });

  it("cannot write to the repository, mint an OIDC token, or read a secret", () => {
    // Read from the parsed permissions rather than the file's text: a prose line explaining why
    // `contents: write` is absent contains the string `contents: write`, and a check a comment can
    // fail is a check that will be silenced rather than fixed.
    const granted = Object.entries({
      ...parsed.permissions,
      ...Object.values(parsed.jobs).reduce((all, job) => ({ ...all, ...job.permissions }), {}),
    });
    expect(granted.filter(([, level]) => level === "write")).toEqual([
      ["security-events", "write"],
    ]);

    const declarations = text.replace(/^\s*#.*$/gm, "");
    expect(declarations).not.toMatch(/id-token/);
    expect(declarations).not.toMatch(/secrets\./);
    expect(declarations).not.toMatch(/^\s*environment:/m);
    expect(runs).not.toMatch(/git\s+push/);
    expect(runs).not.toMatch(/gh\s+(?:release|api\s+-X|pr)/);
  });

  it("passes every dispatch input through env rather than into a shell command", () => {
    // A `${{ inputs… }}` interpolated straight into `run:` is substituted before the shell parses
    // the line. Dispatching needs write access, so this is not a boundary against a stranger — but
    // it is the difference between a bad value failing a validator and a bad value being executed.
    const job = parsed.jobs.canary;
    expect(job?.env?.CANARY_REF).toBe("${{ inputs.canary_ref }}");
    expect(job?.env?.SHA_BEFORE).toBe("${{ inputs.sha_before }}");
    expect(job?.env?.SHA_AFTER).toBe("${{ inputs.sha_after }}");
    expect(runs).not.toContain("${{ inputs.canary_ref }}");
    expect(runs).not.toContain("${{ inputs.sha_before }}");
    expect(runs).not.toContain("${{ inputs.sha_after }}");
  });
});

describe("sarif-upload-canary.yml routes through the contract", () => {
  it("validates the ref and both SHAs before anything else uses them", () => {
    const validateIndex = steps.findIndex((step) =>
      step.run?.includes("sarif-canary.mjs validate"),
    );
    expect(validateIndex).toBeGreaterThanOrEqual(0);
    const firstUse = steps.findIndex((step) =>
      /sarif-canary\.mjs (?:upload|cleanup|observe)|git (?:fetch|checkout)/.test(step.run ?? ""),
    );
    expect(firstUse).toBeGreaterThan(validateIndex);
  });

  it("never resolves a ref or a category in the workflow shell", () => {
    // The workflow is wiring. A second copy of "which ref is the canary's" or "which categories it
    // owns" would be a copy that the contract tests do not cover.
    expect(runs).not.toContain("refs/heads/fairux-sarif-canary-");
    expect(runs).toContain("--category fairux-sarif-canary-v1-physical");
    expect(runs).toMatch(/--category fairux-sarif-canary-v1-logical$/m);
    expect(runs).toContain("--category fairux-sarif-canary-v1-logical-nolocations");
    expect(runs).toContain("--category fairux-sarif-canary-v1-logical-inputfile");
  });

  it("runs the four stages in order, and only in observe mode", () => {
    const stageRuns = steps.filter((step) => /Stage [ABCD]/.test(step.name ?? ""));
    expect(stageRuns.map((step) => step.name?.slice(0, 7))).toEqual([
      "Stage A",
      "Stage B",
      "Stage C",
      "Stage D",
    ]);
    for (const step of stageRuns) {
      expect(step.if, step.name).toBe("${{ inputs.mode == 'observe' }}");
    }
  });

  it("deletes only in cleanup mode", () => {
    const cleanupSteps = steps.filter((step) => step.run?.includes("sarif-canary.mjs cleanup"));
    expect(cleanupSteps).toHaveLength(1);
    expect(cleanupSteps[0]?.if).toBe("${{ inputs.mode == 'cleanup' }}");
  });

  it("takes only the fixtures from the canary commits, never the scripts", () => {
    // The uploading code stays at the reviewed commit the workflow ran from. Checking out a canary
    // commit wholesale would let whoever pushed that branch decide what the upload does.
    const checkouts = runs.match(/git checkout \S+ -- \S+/g) ?? [];
    expect(checkouts.length).toBe(2);
    for (const checkout of checkouts) {
      expect(checkout).toMatch(/-- tests\/fixtures\/sarif-canary$/);
    }
  });

  it("records a processing failure only where acceptance is the question", () => {
    // The physical upload must still abort on a refusal: it is the stage every later one depends
    // on, and swallowing its failure would make a red observation look like a green one.
    const uploads = runs.match(/sarif-canary\.mjs upload[^|]*/g) ?? [];
    const recording = uploads.filter((line) => line.includes("--record-processing-failure"));
    expect(uploads.length).toBe(6);
    expect(recording.length).toBe(3);
    for (const line of recording) {
      expect(line).toMatch(/logical/);
    }
  });

  it("observes after every upload, so no stage reports on the previous one's state", () => {
    for (const stage of [
      "stage-a-observe",
      "stage-b-observe",
      "stage-c-observe",
      "stage-d-observe",
    ]) {
      expect(runs).toContain(`${stage}.json`);
    }
    expect(runs).toContain("stage-b-compare.json");
  });

  it("keeps the evidence even when a stage fails", () => {
    // A stage that failed mid-upload is exactly when the owner needs to know what exists before
    // running cleanup.
    const upload = steps.find((step) => step.uses?.startsWith("actions/upload-artifact@"));
    expect(upload?.if).toBe("${{ always() }}");
    expect(upload?.with?.["if-no-files-found"]).toBe("error");
  });
});
