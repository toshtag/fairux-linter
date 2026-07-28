import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

/**
 * The SDK's beta gate, tested by running it.
 *
 * Four checks described themselves as beta-only while accepting any SemVer prerelease — or, in the
 * release check, any string with a hyphen in it. `0.1.0-alpha.1`, `0.1.0-rc.1`, and the purely
 * numeric `0.1.0-1` satisfied all four, so the tag would proceed through `pnpm install` and a full
 * dry-run pack before anything refused it, and every gate meant something different by the same
 * word (issue #68).
 *
 * These cases run the validator and read its exit status. An assertion that the workflow *mentions*
 * the helper would pass for a script that called it and ignored the answer.
 */

const root = resolve(import.meta.dirname, "../..");
const validator = resolve(root, "scripts/check-sdk-release-version.mjs");

const run = (version: string): { status: number; stderr: string } => {
  try {
    execFileSync(process.execPath, [validator, version], { stdio: "pipe" });
    return { status: 0, stderr: "" };
  } catch (error) {
    const failure = error as { status?: number; stderr?: Buffer };
    return { status: failure.status ?? -1, stderr: String(failure.stderr ?? "") };
  }
};

describe("SDK release version gate — what it accepts", () => {
  it.each(["0.1.0-beta", "0.1.0-beta.1", "0.1.0-beta.2", "9.9.9-beta.42", "0.1.0-beta.2+build.1"])(
    "accepts %s",
    (version) => {
      expect(run(version).status).toBe(0);
    },
  );
});

describe("SDK release version gate — what it refuses", () => {
  it.each(["0.1.0-alpha.1", "0.1.0-rc.1", "0.1.0-1", "0.1.0-betamax.1"])(
    "refuses %s, a prerelease that is not a beta",
    (version) => {
      const result = run(version);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("requires a beta prerelease version");
    },
  );

  it.each(["1.0.0", "1.0.0+beta"])("refuses the stable version %s", (version) => {
    expect(run(version).status).toBe(1);
  });

  it.each(["beta", "v1.0.0", "1.0", "01.0.0", ""])(
    "refuses %j, which is not SemVer at all",
    (version) => {
      const result = run(version);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("not valid SemVer");
    },
  );

  it("exits 2 when given no version, which is a different failure", () => {
    try {
      execFileSync(process.execPath, [validator], { stdio: "pipe" });
      throw new Error("expected a non-zero exit");
    } catch (error) {
      expect((error as { status?: number }).status).toBe(2);
    }
  });
});

describe("SDK release version gate — where the workflow runs it", () => {
  const workflow = parse(
    readFileSync(resolve(root, ".github/workflows/publish-sdk.yml"), "utf8"),
  ) as {
    jobs: Record<string, { needs?: string | string[]; steps?: Array<{ run?: string }> }>;
  };
  const runsOf = (job: string) =>
    (workflow.jobs[job]?.steps ?? []).map((step) => step.run ?? "").join("\n");

  it("runs in validate, which every other job needs", () => {
    // The point of the gate is where it sits. `sdk-smoke` installs dependencies and packs; running
    // the version check only there means an rc gets that far before being refused.
    expect(runsOf("validate")).toContain("node scripts/check-sdk-release-version.mjs");
    expect(runsOf("validate")).not.toContain("pnpm install");

    expect(workflow.jobs["sdk-smoke"]?.needs).toBe("validate");
    expect(workflow.jobs.prepare?.needs).toBe("validate");
    expect(workflow.jobs.publish?.needs).toContain("validate");
  });

  it("no longer decides eligibility from an inline prerelease boolean", () => {
    const validate = runsOf("validate");
    expect(validate).not.toContain("classifyVersion(version).prerelease");
    expect(validate).not.toContain("if (!prerelease)");
  });
});

describe("SDK release version gate — the other gates agree", () => {
  it.each([
    ["packages/sdk/scripts/release-check.mjs", "isBetaPrerelease(version)"],
    ["scripts/assemble-release-bundle.mjs", "isBetaPrerelease(manifest.version)"],
    ["scripts/release-bundle-contract.mjs", "isBetaPrerelease(version)"],
  ])("%s uses the shared contract", (file, call) => {
    expect(readFileSync(resolve(root, file), "utf8")).toContain(call);
  });

  it("leaves no weaker spelling of the same invariant behind", () => {
    const check = readFileSync(resolve(root, "packages/sdk/scripts/release-check.mjs"), "utf8");
    expect(check).not.toContain('version.includes("-")');
  });
});
