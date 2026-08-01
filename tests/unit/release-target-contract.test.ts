import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  auditPublishedRelease,
  auditReleaseTargetEnvironment,
  parseChecksumFile,
  RELEASE_REPOSITORY,
} from "../../scripts/release-target-contract.mjs";

/**
 * The two boundaries that fail silently.
 *
 * `gh` resolves its target from the environment, so an inherited `GH_REPO` sends a release write at
 * another repository while every other check in the run passes. And a Release was never read back:
 * "the bytes were handed to GitHub" is strictly weaker than "these bytes are what GitHub serves",
 * which is exactly the distinction the registry half of the same path already makes.
 *
 * Neither would be caught by a green publish run — the run that wrote to the wrong place, or
 * uploaded the wrong bytes, would report success.
 */

const root = resolve(import.meta.dirname, "../..");
const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);

describe("where a release write may land", () => {
  it("accepts an environment that names this repository, or names nothing", () => {
    expect(auditReleaseTargetEnvironment({ GITHUB_REPOSITORY: RELEASE_REPOSITORY })).toEqual([]);
    // Setting it correctly is fine. Refusing that would push someone toward unsetting it, which is
    // what makes the next inherited value invisible again.
    expect(
      auditReleaseTargetEnvironment({
        GH_REPO: RELEASE_REPOSITORY,
        GITHUB_REPOSITORY: RELEASE_REPOSITORY,
      }),
    ).toEqual([]);
    expect(auditReleaseTargetEnvironment({})).toEqual([]);
  });

  it("refuses a GH_REPO pointing somewhere else", () => {
    const failures = auditReleaseTargetEnvironment({ GH_REPO: "someone-else/fairux-linter" });
    expect(failures.join(" ")).toContain("GH_REPO");
    expect(failures.join(" ")).toContain("different repository");
  });

  it("refuses a different GitHub host outright", () => {
    // Neither has a correct value here, and both point at a different GitHub.
    expect(auditReleaseTargetEnvironment({ GH_HOST: "github.example.com" }).length).toBe(1);
    expect(auditReleaseTargetEnvironment({ GH_ENTERPRISE_TOKEN: "x" }).length).toBe(1);
  });

  it("refuses a run on a fork or after a rename", () => {
    // A run whose own repository is not this one should not publish a Release under this name.
    expect(
      auditReleaseTargetEnvironment({ GITHUB_REPOSITORY: "fork/fairux-linter" }).join(" "),
    ).toContain("GITHUB_REPOSITORY");
  });

  it("reports every problem at once rather than the first", () => {
    expect(
      auditReleaseTargetEnvironment({
        GH_REPO: "elsewhere/x",
        GH_HOST: "github.example.com",
        GITHUB_REPOSITORY: "fork/y",
      }),
    ).toHaveLength(3);
  });
});

describe("reading a checksum file", () => {
  it("reads the `sha256  name` form the bundle writes", () => {
    expect(parseChecksumFile(`${SHA_A}  fairux-0.1.0.tgz\n`)).toEqual(
      new Map([["fairux-0.1.0.tgz", SHA_A]]),
    );
  });

  it("ignores anything that is not a checksum line", () => {
    expect(parseChecksumFile(`# a comment\n\n${SHA_A}  x.tgz\nnot a line\n`).size).toBe(1);
  });
});

describe("what the published Release must be", () => {
  const expectedAssets = new Map([
    ["fairux-0.1.0.tgz", SHA_A],
    ["release-sha256.txt", SHA_B],
  ]);
  const downloaded = new Map(expectedAssets);
  const release = {
    tagName: "v0.1.0",
    isDraft: false,
    assets: [
      { name: "fairux-0.1.0.tgz", state: "uploaded" },
      { name: "release-sha256.txt", state: "uploaded" },
    ],
  };
  const audit = (overrides: Record<string, unknown> = {}, downloads = downloaded) =>
    auditPublishedRelease({
      release: { ...release, ...overrides },
      expectedAssets,
      downloadedAssets: downloads,
      expectedTag: "v0.1.0",
    });

  it("accepts a published Release carrying exactly the audited bytes", () => {
    expect(audit()).toEqual([]);
  });

  /**
   * The mutation set. Each of these is a way a publish run could report success while the Release
   * a consumer downloads is not what the run audited.
   */
  it("refuses bytes that are not the ones this run produced", () => {
    const tampered = new Map(downloaded).set("fairux-0.1.0.tgz", "c".repeat(64));
    expect(audit({}, tampered).join(" ")).toContain("are not the bytes this run audited");
  });

  it("refuses an asset that could not be downloaded", () => {
    const missing = new Map(downloaded);
    missing.delete("fairux-0.1.0.tgz");
    expect(audit({}, missing).join(" ")).toContain("could not be downloaded");
  });

  it("refuses a Release missing an asset entirely", () => {
    expect(
      audit({ assets: [{ name: "release-sha256.txt", state: "uploaded" }] }).join(" "),
    ).toContain("missing the asset fairux-0.1.0.tgz");
  });

  it("refuses an asset this run did not upload", () => {
    // Either a leftover from an attempt that was supposed to be superseded, or something nobody in
    // this run put there. Both are worth stopping for.
    expect(
      audit({ assets: [...release.assets, { name: "extra.zip", state: "uploaded" }] }).join(" "),
    ).toContain("did not upload: extra.zip");
  });

  it("refuses an asset still mid-upload", () => {
    // `uploaded` is the only state a consumer can download from.
    expect(
      audit({
        assets: [
          { name: "fairux-0.1.0.tgz", state: "starter" },
          { name: "release-sha256.txt", state: "uploaded" },
        ],
      }).join(" "),
    ).toContain("not uploaded");
  });

  it("refuses a draft", () => {
    // Reaching this check with a draft means the write did not do what the run reported.
    expect(audit({ isDraft: true }).join(" ")).toContain("is a draft");
    expect(audit({ isDraft: undefined }).join(" ")).toContain("is a draft");
  });

  it("refuses a Release on another tag", () => {
    expect(audit({ tagName: "v0.9.9" }).join(" ")).toContain("expected v0.1.0");
  });

  it("refuses duplicate asset names and unnamed assets", () => {
    expect(
      audit({ assets: [...release.assets, { name: "release-sha256.txt" }] }).join(" "),
    ).toContain("two assets named");
    expect(audit({ assets: [{ state: "uploaded" }] }).join(" ")).toContain("asset with no name");
  });

  it("refuses a response that is not a Release at all", () => {
    for (const value of [null, [], "release", undefined]) {
      expect(
        auditPublishedRelease({
          release: value,
          expectedAssets,
          downloadedAssets: downloaded,
          expectedTag: "v0.1.0",
        }),
        String(value),
      ).toEqual(["gh release view did not return an object"]);
    }
  });
});

/**
 * The checks only matter if the workflows run them, and in the right order: the preflight before
 * the write it is supposed to prevent, the read-back after the write it is supposed to verify.
 */
describe("both publish workflows route through the contract", () => {
  interface Step {
    name?: string;
    run?: string;
    uses?: string;
  }
  const workflowSteps = (file: string): Step[] => {
    const parsed = parse(readFileSync(resolve(root, ".github/workflows", file), "utf8")) as {
      jobs: Record<string, { steps?: Step[] }>;
    };
    return Object.values(parsed.jobs).flatMap((job) => job.steps ?? []);
  };

  for (const file of ["publish-cli.yml", "publish-sdk.yml"]) {
    describe(file, () => {
      const steps = workflowSteps(file);
      const indexOf = (needle: string) =>
        steps.findIndex((step) => step.run?.includes(needle) ?? false);

      it("runs the target preflight before any gh release write", () => {
        const preflight = indexOf("check-release-target.mjs");
        const write = steps.findIndex((step) =>
          /gh release (create|edit|upload)/.test(step.run ?? ""),
        );
        expect(preflight, "the preflight step is missing").toBeGreaterThanOrEqual(0);
        expect(write).toBeGreaterThanOrEqual(0);
        // Before, not merely present: a preflight after the write prevents nothing.
        expect(preflight).toBeLessThan(write);
      });

      it("verifies the published Release after the write", () => {
        const verify = indexOf("verify-published-release.mjs");
        const write = steps.findIndex((step) =>
          /gh release (create|edit|upload)/.test(step.run ?? ""),
        );
        expect(verify, "the read-back step is missing").toBeGreaterThanOrEqual(0);
        expect(verify).toBeGreaterThan(write);
      });

      it("hands the read-back the bundle's own checksum file", () => {
        const verify = steps.find((step) => step.run?.includes("verify-published-release.mjs"));
        expect(verify?.run).toContain("release-sha256.txt");
        expect(verify?.run).toContain("--asset");
      });
    });
  }
});
