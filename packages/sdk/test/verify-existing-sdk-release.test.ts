import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { auditExistingSdkRelease } from "../scripts/sdk-github-release-contract.mjs";
import { SDK_RUNBOOK } from "../scripts/sdk-release-contract.mjs";

/**
 * The SDK's binding of the shared GitHub Release contract, and the entry point's argument handling.
 *
 * The contract's own behaviour — what it refuses and why repair cannot cover classification — is
 * `tests/unit/cli-github-release-contract.test.ts`, over the same implementation. What is specific
 * to the SDK is the runbook a refusal points at, and it is the value a copy of the CLI's binding
 * would get wrong while every other assertion still passed.
 *
 * `publish-sdk.yml` needs this at all because it classified every Release with a bare
 * `--prerelease`. That is the right answer for every beta and the wrong one for `0.1.0`, and
 * `gh release edit` cannot clear a prerelease flag — so a Release created under the other
 * classification would have been "repaired" into a state the edit could not reach, and the run would
 * have reported success.
 */

const entry = resolve(import.meta.dirname, "../scripts/verify-existing-sdk-release.mjs");

const release = (overrides: Record<string, unknown> = {}) => ({
  tagName: "sdk-v0.1.0",
  isDraft: false,
  isPrerelease: false,
  ...overrides,
});

describe("the SDK's existing-Release audit", () => {
  it("accepts a Release already classified the way this release is", () => {
    expect(
      auditExistingSdkRelease({
        expectedTag: "sdk-v0.1.0",
        expectedPrerelease: false,
        release: release(),
      }),
    ).toEqual([]);
  });

  it("refuses a Release classified the other way, and says why repair cannot fix it", () => {
    const failures = auditExistingSdkRelease({
      expectedTag: "sdk-v0.1.0",
      expectedPrerelease: false,
      release: release({ isPrerelease: true }),
    });
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain("cannot clear a prerelease flag");
  });

  it("sends a reader to the SDK runbook, not the CLI's", () => {
    // The one value a copy of the CLI's binding would get wrong while everything else passed.
    const [failure] = auditExistingSdkRelease({
      expectedTag: "sdk-v0.1.0",
      expectedPrerelease: true,
      release: release({ isDraft: true, isPrerelease: true }),
    });
    expect(failure).toContain(SDK_RUNBOOK);
    expect(failure).not.toContain("release-cli.md");
  });
});

describe("the entry point's arguments", () => {
  const run = (args: string[]) => {
    try {
      execFileSync(process.execPath, [entry, ...args], { stdio: "pipe", env: {} });
      return { status: 0, stderr: "" };
    } catch (error) {
      const failure = error as { status?: number; stderr?: Buffer };
      return { status: failure.status ?? -1, stderr: String(failure.stderr ?? "") };
    }
  };

  it("requires --prerelease to be exactly true or false", () => {
    // It arrives through `GITHUB_ENV` as text. A misspelled value read as falsy would expect a
    // stable Release for a prerelease — and then repair it into the wrong classification.
    for (const value of ["", "yes", "TRUE", "1"]) {
      const result = run(["--tag", "sdk-v0.1.0", "--prerelease", value, "--repository", "o/r"]);
      expect(result.status, value).toBe(2);
      expect(result.stderr).toContain("--prerelease must be true or false");
    }
  });

  it("requires a tag and a repository", () => {
    expect(run(["--prerelease", "false", "--repository", "o/r"]).status).toBe(2);
    // `env: {}` above means no `GITHUB_REPOSITORY` to fall back to.
    expect(run(["--tag", "sdk-v0.1.0", "--prerelease", "false"]).status).toBe(2);
  });
});
