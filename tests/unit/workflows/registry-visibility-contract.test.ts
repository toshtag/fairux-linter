import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  parseRegistryPlanArgs,
  RegistryPlanUsageError,
} from "../../../packages/sdk/scripts/release-registry-plan.mjs";
import {
  REGISTRY_WAIT_DELAYS_MS,
  REGISTRY_WAIT_MAX_ELAPSED_MS,
} from "../../../scripts/release-registry-wait.mjs";

/**
 * Pins which side of `npm publish` may wait for the registry.
 *
 * `release-registry-plan.mjs` answers two different questions with one script, and the workflow is
 * the only place that decides which. Before the publish, absence is the expected answer and the
 * publish is the fix; after it, absence contradicts a write the registry accepted — which is how
 * `sdk-v0.1.0-beta.2` ended up published with its run recorded as a failure and no GitHub Release
 * (run 30258382164, attempt 2).
 *
 * A string search for the flag would pass with it on the wrong step, so the contract is a checker
 * the mutation controls at the bottom run against realistic drift, and the argument lists are fed to
 * the real parser rather than only matched as text.
 */

const root = resolve(import.meta.dirname, "../../..");

interface Step {
  name?: string;
  run?: string;
}
interface Workflow {
  jobs: Record<string, { steps?: Step[] }>;
}

/**
 * The plan's machinery is shared with the CLI release path; the SDK's file binds its registry
 * arguments to it. Read as text for the few properties that are statements about the source
 * itself — a monotonic clock, a per-attempt cache — rather than about a return value.
 */
const SHARED_PLAN_SOURCE = readFileSync(resolve(root, "scripts/release-registry-plan.mjs"), "utf8");
const SDK_PLAN_SOURCE = readFileSync(
  resolve(root, "packages/sdk/scripts/release-registry-plan.mjs"),
  "utf8",
);

const workflow = parse(
  readFileSync(resolve(root, ".github/workflows/publish-sdk.yml"), "utf8"),
) as Workflow;

const publishSteps = workflow.jobs.publish?.steps ?? [];

/**
 * The arguments a step passes to the plan script, as the script itself would see them.
 *
 * Shell line continuations and the `"$VAR"` quoting are removed; the placeholders survive as
 * literal strings, which is all the argument contract needs.
 */
const planArgv = (run: string): string[] =>
  run
    .replace(/\\\n/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .map((token) => token.replace(/^"(.*)"$/, "$1"))
    .slice(2); // drop `node` and the script path

const planSteps = publishSteps
  .filter((step) => step.run?.includes("release-registry-plan.mjs"))
  .map((step) => ({ name: step.name ?? "", argv: planArgv(step.run ?? "") }));

/**
 * The contract, as a function, so it can be shown to reject each way the flags could drift rather
 * than only to accept the current file.
 */
const registryWaitContractErrors = (steps: Array<{ name: string; argv: string[] }>): string[] => {
  const errors: string[] = [];
  const preflight = steps.filter((step) => !step.argv.includes("--require-present"));
  const verification = steps.filter((step) => step.argv.includes("--require-present"));

  if (preflight.length !== 1)
    errors.push(`expected one pre-publish plan step, got ${preflight.length}`);
  if (verification.length !== 1) {
    errors.push(`expected one post-publish verification step, got ${verification.length}`);
  }
  for (const step of preflight) {
    if (step.argv.includes("--wait-for-present")) {
      errors.push(`pre-publish step "${step.name}" must not wait for the registry`);
    }
  }
  for (const step of verification) {
    if (!step.argv.includes("--wait-for-present")) {
      errors.push(`post-publish step "${step.name}" must wait for the registry`);
    }
  }
  return errors;
};

describe("publish-sdk.yml registry visibility", () => {
  it("runs the plan script exactly twice, on either side of the publish", () => {
    // The SDK's `npm publish` moved into `packages/sdk/scripts/publish-sdk.mjs`, so the step is
    // named by the script it calls. The contract is unchanged: one plan read before the
    // publication, one after.
    // Exact: `… || true` contains the path too, and would let the plan ordering be asserted about
    // a step whose failure is discarded.
    const publishIndex = publishSteps.findIndex(
      (step) => step.run?.replace(/\n$/, "") === "node packages/sdk/scripts/publish-sdk.mjs",
    );
    const planIndexes = publishSteps
      .map((step, index) => ({ step, index }))
      .filter(({ step }) => step.run?.includes("release-registry-plan.mjs"))
      .map(({ index }) => index);

    expect(publishIndex).toBeGreaterThanOrEqual(0);
    expect(planIndexes).toHaveLength(2);
    expect(planIndexes[0]).toBeLessThan(publishIndex);
    expect(planIndexes[1]).toBeGreaterThan(publishIndex);
  });

  it("waits after the publish and never before it", () => {
    expect(registryWaitContractErrors(planSteps)).toEqual([]);
  });

  it("passes each step arguments the script itself accepts", () => {
    // The pre-publish step's arguments are not merely missing the flag — they are a combination
    // `parseRegistryPlanArgs` accepts, and adding the flag to them is one it refuses. That is the
    // guard, rather than this file's own opinion about which step is which.
    for (const step of planSteps) {
      expect(() => parseRegistryPlanArgs(step.argv), step.name).not.toThrow();
    }

    const preflight = planSteps.find((step) => !step.argv.includes("--require-present"));
    expect(preflight).toBeDefined();
    expect(() => parseRegistryPlanArgs([...(preflight?.argv ?? []), "--wait-for-present"])).toThrow(
      RegistryPlanUsageError,
    );
  });

  it("keeps both registry keys and the online read on every npm read", () => {
    // The wait re-reads on a schedule; a read pointed at another host, or served from cache, would
    // wait out a state that never existed on the registry the publish wrote to.
    const registry = readFileSync(resolve(root, "scripts/public-npm-registry.mjs"), "utf8");
    expect(registry).toContain('"https://registry.npmjs.org/"');
    expect(registry).toContain('"--prefer-online"');

    // The per-attempt cache lives in the shared plan now: the CLI release path needs the same
    // read, and a second copy of this loop is exactly where the two would drift apart. The SDK's
    // own file binds `NPM_SDK_VIEW_REGISTRY_ARGS` to it and nothing else.
    expect(SHARED_PLAN_SOURCE).toContain("npm_config_cache");
    expect(SDK_PLAN_SOURCE).toContain("NPM_SDK_VIEW_REGISTRY_ARGS");
  });

  it("bounds the whole wait, not only its sleeps", () => {
    // The production deadline is what the workflow step is actually promising when it passes the
    // flag. Bounding only the sleeps left the reads unbounded: with 30s reads the first version of
    // this module slept 97s and ran for 307s.
    expect(REGISTRY_WAIT_MAX_ELAPSED_MS).toBe(120_000);
    const sleeps = REGISTRY_WAIT_DELAYS_MS.reduce((sum, delay) => sum + delay, 0);
    expect(sleeps).toBeLessThan(REGISTRY_WAIT_MAX_ELAPSED_MS);

    // A monotonic clock, so an NTP correction cannot extend or expire the deadline.
    expect(SHARED_PLAN_SOURCE).toContain("now = () => performance.now()");
    expect(SHARED_PLAN_SOURCE).not.toContain("now = () => Date.now()");
  });
});

describe("registry visibility contract, mutated", () => {
  const preflight = { name: "Plan npm publication", argv: ["--spec", "$SPEC"] };
  const verification = {
    name: "Verify registry digest",
    argv: ["--spec", "$SPEC", "--require-present", "--wait-for-present"],
  };

  const mutations: Array<[string, Array<{ name: string; argv: string[] }>]> = [
    [
      "dropping the wait from the post-publish step",
      [preflight, { ...verification, argv: ["--spec", "$SPEC", "--require-present"] }],
    ],
    [
      "adding the wait to the pre-publish step",
      [{ ...preflight, argv: [...preflight.argv, "--wait-for-present"] }, verification],
    ],
    ["removing the post-publish step entirely", [preflight]],
    ["removing the pre-publish step entirely", [verification]],
    [
      "waiting on both steps",
      [{ ...preflight, argv: [...preflight.argv, "--wait-for-present"] }, verification],
    ],
  ];

  it.each(mutations)("rejects %s", (_label, steps) => {
    expect(registryWaitContractErrors(steps)).not.toEqual([]);
  });

  it("accepts only the split the workflow actually uses", () => {
    expect(registryWaitContractErrors([preflight, verification])).toEqual([]);
  });
});
