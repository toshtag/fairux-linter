import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The generic SemVer validator, tested by running it.
 *
 * It exists because a registry canary needs untrusted-input validation and not a publication
 * policy: `check-sdk-release-version.mjs` is the release gate and decides what this repository will
 * publish, so borrowing it would fail a canary the day a dist-tag advances to something that gate
 * refuses — with no consumer-compatibility fact behind the failure. This validator accepts exactly
 * one strict SemVer version of any flavour, and refuses the shapes that make an unvalidated
 * `GITHUB_ENV` write dangerous: whitespace, newlines, shell fragments, prefixes.
 *
 * The canaries reach the same grammar through `registry-channel-contract.mjs`, which adds what a
 * bare version check cannot decide — whether the channel resolved to anything, and whether what it
 * resolved to is a release rather than the bootstrap placeholder. The release gate keeps its own
 * tests in `sdk-release-version-gate.test.ts`.
 */

const root = resolve(import.meta.dirname, "../..");
const validator = resolve(root, "scripts/check-semver.mjs");

const run = (version: string): { status: number; stderr: string } => {
  try {
    execFileSync(process.execPath, [validator, version], { stdio: "pipe" });
    return { status: 0, stderr: "" };
  } catch (error) {
    const failure = error as { status?: number; stderr?: Buffer };
    return { status: failure.status ?? -1, stderr: String(failure.stderr ?? "") };
  }
};

describe("generic SemVer validator — what it accepts", () => {
  it.each(["0.1.0-beta.2", "0.2.0-rc.1", "0.1.0-alpha.1", "0.1.0-1", "1.0.0", "1.0.0+build.1"])(
    "accepts %s",
    (version) => {
      expect(run(version).status).toBe(0);
    },
  );
});

describe("generic SemVer validator — what it refuses", () => {
  it.each(["alpha", "v1.0.0", "prefix-1.0.0", "1.0", "01.0.0", ""])(
    "refuses %j, which is not SemVer",
    (version) => {
      const result = run(version);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("not a strict SemVer version");
    },
  );

  it.each([
    ["a trailing newline", "1.0.0\n"],
    ["an embedded newline", "1.0.0\nINJECTED=1"],
    ["a shell fragment", "1.0.0;echo"],
    ["an embedded space", "1.0.0 --flag"],
  ])("refuses %s", (_label, version) => {
    // The anchored SemVer regex alone is not enough here: a JavaScript `$` without the `m` flag
    // also matches just before a trailing newline, and a trailing newline is exactly what turns a
    // `GITHUB_ENV` write into an arbitrary variable definition.
    expect(run(version).status).toBe(1);
  });

  it("exits 2 when given no version, which is a different failure", () => {
    try {
      execFileSync(process.execPath, [validator], { stdio: "pipe" });
      throw new Error("expected a non-zero exit");
    } catch (error) {
      expect((error as { status?: number }).status).toBe(2);
    }
  });
});
