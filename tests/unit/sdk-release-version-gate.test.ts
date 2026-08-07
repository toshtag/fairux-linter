import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

/**
 * The SDK's release gate, tested by running it.
 *
 * ## What this file used to assert, and why it changed
 *
 * It asserted beta-only. Four checks had described themselves that way while accepting any SemVer
 * prerelease — or, in the release check, any string with a hyphen in it — so `0.1.0-alpha.1`,
 * `0.1.0-rc.1`, and the purely numeric `0.1.0-1` satisfied all four (issue #68). Giving them one
 * meaning was right; making that meaning "beta" was right for a beta-only line and is the rule the
 * first stable SDK release has to break, because `0.1.0` is not a beta.
 *
 * The gate is the repository's channel policy now: a prerelease of any kind publishes to `next`, a
 * version with no prerelease identifier publishes to `latest`, and the bootstrap placeholder is
 * refused. The widening is deliberate and is what the "accepts" block below is for — an rc reaching
 * `next` is now correct rather than a bug, and it is written down here so nobody has to infer it
 * from a check's absence.
 *
 * What the widening does **not** touch is `latest`. Only a version with no prerelease identifier
 * derives that channel, and `scripts/release-channel-contract.mjs` refuses a prerelease sitting
 * there on both sides of the publish.
 *
 * These cases run the validator and read its exit status. An assertion that the workflow *mentions*
 * the helper would pass for a script that called it and ignored the answer.
 */

const root = resolve(import.meta.dirname, "../..");
const validator = resolve(root, "packages/sdk/scripts/check-sdk-release-version.mjs");
const manifestVersion = (
  JSON.parse(readFileSync(resolve(root, "packages/sdk/package.json"), "utf8")) as {
    version: string;
  }
).version;

const run = (tag: string): { status: number; stdout: string; stderr: string } => {
  try {
    const stdout = execFileSync(process.execPath, [validator, tag], { stdio: "pipe" });
    return { status: 0, stdout: String(stdout), stderr: "" };
  } catch (error) {
    const failure = error as { status?: number; stdout?: Buffer; stderr?: Buffer };
    return {
      status: failure.status ?? -1,
      stdout: String(failure.stdout ?? ""),
      stderr: String(failure.stderr ?? ""),
    };
  }
};

describe("SDK release gate — the tag it is actually given", () => {
  it("accepts the tag this checkout's manifest would be released under", () => {
    // The only version the gate can accept end to end, because it also compares the tag against
    // the manifest. Everything below exercises the tag half against a manifest that says otherwise.
    const result = run(`sdk-v${manifestVersion}`);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(`releases @fairux/sdk ${manifestVersion}`);
    expect(result.stdout).toMatch(/dist-tag: (next|latest)/);
  });

  it("refuses a tag that does not name the manifest version", () => {
    const result = run("sdk-v9.9.9");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("does not match the manifest version");
  });
});

describe("SDK release gate — which versions are releasable at all", () => {
  // The tag half in isolation: these all fail the manifest comparison too, so the assertion is on
  // the *reason*, which is reported before the manifest is read.
  it.each([
    ["sdk-v0.1.0-alpha.1", "next"],
    ["sdk-v0.1.0-rc.1", "next"],
    ["sdk-v0.1.0-1", "next"],
    ["sdk-v0.9.9-beta.4", "next"],
    ["sdk-v1.0.0", "latest"],
  ])("%s is a release this workflow performs", (tag) => {
    // Not `status === 0`: the manifest says a different version. What matters is that the *only*
    // refusal is the version mismatch — the tag itself is eligible. An earlier gate refused
    // `sdk-v0.1.0-rc.1` and `sdk-v1.0.0` outright, and this is where that would come back.
    const result = run(tag);
    expect(result.stderr).toContain("does not match the manifest version");
    expect(result.stderr).not.toContain("bootstrap placeholder");
    expect(result.stderr).not.toContain("valid SemVer");
    expect(result.stderr).not.toContain("prerelease version");
  });

  it("refuses the bootstrap placeholder, which is published by hand and never by this workflow", () => {
    const result = run("sdk-v0.0.0-bootstrap.0");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("bootstrap placeholder");
    expect(result.stderr).toContain("docs/maintainers/release-sdk.md");
  });

  it.each(["sdk-vbeta", "sdk-v1.0", "sdk-v01.0.0", "sdk-vv1.0.0"])(
    "refuses %s, which carries no valid SemVer version",
    (tag) => {
      const result = run(tag);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("does not carry a valid SemVer version");
    },
  );

  it("refuses a tag with the CLI's prefix, which the other workflow owns", () => {
    const result = run("v0.1.0");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('must start with "sdk-v"');
  });

  it("exits 2 when given no tag, which is a different failure", () => {
    try {
      execFileSync(process.execPath, [validator], { stdio: "pipe" });
      throw new Error("expected a non-zero exit");
    } catch (error) {
      expect((error as { status?: number }).status).toBe(2);
    }
  });
});

describe("SDK release gate — where the workflow runs it", () => {
  const workflow = parse(
    readFileSync(resolve(root, ".github/workflows/publish-sdk.yml"), "utf8"),
  ) as {
    jobs: Record<string, { needs?: string | string[]; steps?: Array<{ run?: string }> }>;
  };
  const runsOf = (job: string) =>
    (workflow.jobs[job]?.steps ?? []).map((step) => step.run ?? "").join("\n");

  it("runs in validate, which every other job needs", () => {
    // The point of the gate is where it sits. `sdk-smoke` installs dependencies and packs; running
    // the version check only there means an ineligible tag gets that far before being refused.
    expect(runsOf("validate")).toContain("node packages/sdk/scripts/check-sdk-release-version.mjs");
    expect(runsOf("validate")).not.toContain("pnpm install");

    expect(workflow.jobs["sdk-smoke"]?.needs).toBe("validate");
    expect(workflow.jobs.prepare?.needs).toBe("validate");
    expect(workflow.jobs.publish?.needs).toContain("validate");
  });

  it("no longer decides eligibility, or the manifest's identity, in shell", () => {
    const validate = runsOf("validate");
    expect(validate).not.toContain("classifyVersion(version).prerelease");
    expect(validate).not.toContain("if (!prerelease)");
    // The name, `private`, and tag/version comparisons used to be three `node -p` reads and three
    // `if` blocks here. A shell comparison is not something a test can run.
    expect(validate).not.toContain("PKG_PRIVATE");
    expect(validate).not.toContain("TAG_VERSION");
  });
});

describe("SDK release gate — the other gates agree", () => {
  it.each([
    ["packages/sdk/scripts/release-check.mjs", "resolveSdkRelease(tag)"],
    ["scripts/assemble-release-bundle.mjs", "releaseDistTag(manifest.version)"],
    ["scripts/release-bundle-contract.mjs", "releaseDistTag(version)"],
  ])("%s uses the shared contract", (file, call) => {
    expect(readFileSync(resolve(root, file), "utf8")).toContain(call);
  });

  it("leaves no weaker spelling of the same invariant behind", () => {
    const check = readFileSync(resolve(root, "packages/sdk/scripts/release-check.mjs"), "utf8");
    expect(check).not.toContain('version.includes("-")');
    // And no beta-only gate anywhere on the SDK release path: a leftover would refuse `0.1.0`
    // somewhere further down than the tag gate, which is the failure mode issue #68 described.
    // A *call*, not the word — the comments that explain what was removed name it, and a check that
    // forbade the name would forbid the explanation.
    for (const file of [
      "packages/sdk/scripts/release-check.mjs",
      "packages/sdk/scripts/release-notes.mjs",
      "packages/sdk/scripts/publish-sdk.mjs",
      "scripts/assemble-release-bundle.mjs",
      "scripts/release-bundle-contract.mjs",
    ]) {
      expect(readFileSync(resolve(root, file), "utf8"), file).not.toMatch(/isBetaPrerelease\(/);
    }
  });
});
