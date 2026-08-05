import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const root = resolve(import.meta.dirname, "../../..");
const expectedRange = "^22.18.0 || >=24.11.0";
const expectedFloor = "22.18.0";
const expectedFloors = ["22.18.0", "24.11.0"];

function readJson(path: string): {
  engines?: { node?: string };
  devDependencies?: Record<string, string>;
} {
  return JSON.parse(readFileSync(resolve(root, path), "utf8"));
}

interface Workflow {
  env?: Record<string, unknown>;
  jobs: Record<
    string,
    {
      strategy?: { matrix?: Record<string, unknown> };
      steps?: Array<{ run?: string; uses?: string; with?: Record<string, unknown> }>;
    }
  >;
}

function readWorkflow(path = ".github/workflows/ci.yml"): Workflow {
  return parse(readFileSync(resolve(root, path), "utf8"));
}

function setupNodeVersion(workflow: ReturnType<typeof readWorkflow>, jobName: string): unknown {
  const step = workflow.jobs[jobName]?.steps?.find((candidate) =>
    candidate.uses?.startsWith("actions/setup-node@"),
  );
  return step?.with?.["node-version"];
}

describe("Node.js support contract", () => {
  it("aligns package engine declarations and repository default", () => {
    expect(readJson("package.json").engines?.node).toBe(expectedRange);
    expect(readJson("apps/cli/package.json").engines?.node).toBe(expectedRange);
    expect(readJson("packages/sdk/package.json").engines?.node).toBe(expectedRange);
    expect(readFileSync(resolve(root, ".node-version"), "utf8").trim()).toBe(expectedFloor);
    expect(readJson("package.json").devDependencies?.["@types/node"]).toBe("^22.18.0");
  });

  /**
   * The pull-request lane installs one version, it is exact, and it is inside the declared range.
   *
   * It used to be required to *be* the 22.18.0 floor. That cost about five seconds per job:
   * `actions/setup-node` resolves from the runner image's tool cache and neither floor is in it, so
   * six jobs downloaded and extracted Node before doing any work. What the floor requirement was
   * actually protecting — that the suite is observed on both declared versions — is now owned by
   * `release-contract.yml`'s `suite-on-both-floors`, and `supported-platforms-contract.test.ts`
   * fails if that job stops existing.
   *
   * So this asserts what is left to assert, and it is not weaker: one source for every job in the
   * lane, no mutable alias, and inside `engines`. A floating `22` fails the second, which is the
   * property `action-runtime-contract.test.ts` refuses to give up for actions.
   */
  it("installs one exact, in-range Node.js in the pull-request lane", () => {
    const ci = readWorkflow();
    const laneVersion = String(ci.env?.PR_LANE_NODE ?? "");

    expect(laneVersion, "ci.yml must name its Node version once, in env").toMatch(
      /^\d+\.\d+\.\d+$/,
    );
    for (const jobName of ["verify", "test"]) {
      // Read from one place, so every matrix-expanded job uses the same version.
      expect(setupNodeVersion(ci, jobName), jobName).toBe("${{ env.PR_LANE_NODE }}");
    }

    // `^22.18.0 || >=24.11.0`, evaluated against exactly that range rather than by a general semver
    // engine: some floor shares the version's major, and the version is not below it.
    const parts = (version: string) => version.split(".").map(Number) as [number, number, number];
    const [laneMajor, laneMinor, lanePatch] = parts(laneVersion);
    const satisfied = expectedFloors.some((floor) => {
      const [major, minor, patch] = parts(floor);
      if (major !== laneMajor) return false;
      if (laneMinor !== minor) return laneMinor > minor;
      return lanePatch >= patch;
    });
    expect(satisfied, `${laneVersion} is outside ${expectedRange}`).toBe(true);
  });

  it("uses exact supported Node.js floors where the floors are the claim", () => {
    const releaseContract = readWorkflow(".github/workflows/release-contract.yml");

    expect(setupNodeVersion(releaseContract, "config-windows")).toBe(expectedFloor);
    for (const jobName of [
      "pack-smoke",
      "sdk-pack-smoke",
      "sdk-release-preflight",
      "rule-pack-author-example",
      "build-output-contract",
    ]) {
      expect(releaseContract.jobs[jobName]?.strategy?.matrix?.["node-version"], jobName).toEqual(
        expectedFloors,
      );
    }
  });

  it("uses the exact Node.js 24 publish floor for CLI npm trusted publishing", () => {
    const workflow = readWorkflow(".github/workflows/publish-cli.yml");

    expect(setupNodeVersion(workflow, "publish")).toBe("24.11.0");
    expect(
      workflow.jobs.publish?.steps?.some((step) =>
        step.run?.includes("Expected Node 24.11.0 or newer on the Node 24 publish line"),
      ),
    ).toBe(true);
  });

  it("uses the exact Node.js floors for SDK release smoke and publish", () => {
    const workflow = readWorkflow(".github/workflows/publish-sdk.yml");

    expect(workflow.jobs["sdk-smoke"]?.strategy?.matrix?.["node-version"]).toEqual(expectedFloors);
    expect(setupNodeVersion(workflow, "publish")).toBe("24.11.0");
    expect(
      workflow.jobs.publish?.steps?.some((step) =>
        step.run?.includes("Expected Node 24.11.0 or newer"),
      ),
    ).toBe(true);
    // The beta refusal lives in the unprivileged `validate` job, which gates every other job —
    // it runs before anything installs a dependency or can mint an OIDC token.
    expect(
      workflow.jobs.validate?.steps?.some((step) =>
        step.run?.includes("scripts/check-sdk-release-version.mjs"),
      ),
    ).toBe(true);
    expect(setupNodeVersion(workflow, "prepare")).toBe("24.11.0");
    expect(
      workflow.jobs.publish?.steps?.some((step) => step.run?.includes("release-registry-plan.mjs")),
    ).toBe(true);
    expect(
      workflow.jobs.publish?.steps?.some(
        (step) => step.run?.includes("gh release edit") && step.run.includes("--clobber"),
      ),
    ).toBe(true);
  });
});
