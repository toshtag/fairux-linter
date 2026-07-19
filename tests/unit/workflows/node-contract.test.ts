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

  it("uses exact supported Node.js floors in CI", () => {
    const workflow = readWorkflow();

    expect(setupNodeVersion(workflow, "verify")).toBe(expectedFloor);
    expect(setupNodeVersion(workflow, "config-windows")).toBe(expectedFloor);
    expect(workflow.jobs["pack-smoke"]?.strategy?.matrix?.["node-version"]).toEqual(expectedFloors);
    expect(workflow.jobs["sdk-pack-smoke"]?.strategy?.matrix?.["node-version"]).toEqual(
      expectedFloors,
    );
  });

  it("uses the exact Node.js 24 publish floor for npm trusted publishing", () => {
    const workflow = readWorkflow(".github/workflows/publish.yml");

    expect(setupNodeVersion(workflow, "publish")).toBe("24.11.0");
    expect(
      workflow.jobs.publish?.steps?.some((step) =>
        step.run?.includes("Expected Node 24.11.0 or newer on the Node 24 publish line"),
      ),
    ).toBe(true);
  });
});
