import { describe, expect, it } from "vitest";
import {
  CLI_BOOTSTRAP_DIST_TAG,
  CLI_BOOTSTRAP_VERSION,
  CLI_PRERELEASE_DIST_TAG,
  CLI_STABLE_DIST_TAG,
  CLI_TAG_PREFIX,
  CliReleaseError,
  cliReleaseSpec,
  cliReleaseTag,
  cliTarballName,
  resolveCliRelease,
} from "../scripts/cli-release-contract.mjs";

/**
 * The tag gate, which runs before any job installs a dependency.
 *
 * `on.push.tags: ["v*"]` is wider than the contract — it matches `vscode-extension-v1` and
 * `v2-spike` too — so the refusals below are the boundary, not the glob.
 *
 * `0.0.0-bootstrap.0` is the case worth staring at. It is a real version that will exist on npm,
 * and it is a prerelease, so the repository-wide "prerelease is next" policy maps it straight onto
 * the beta channel. Nothing about its shape marks it as unpublishable; only this rule does.
 */

describe("resolveCliRelease", () => {
  it.each([
    ["v0.1.0-beta.1", "0.1.0-beta.1", CLI_PRERELEASE_DIST_TAG, true],
    ["v0.1.0-rc.1", "0.1.0-rc.1", CLI_PRERELEASE_DIST_TAG, true],
    ["v0.2.0-alpha.0", "0.2.0-alpha.0", CLI_PRERELEASE_DIST_TAG, true],
    ["v0.1.0", "0.1.0", CLI_STABLE_DIST_TAG, false],
    ["v1.0.0", "1.0.0", CLI_STABLE_DIST_TAG, false],
  ])("resolves %s", (tag, version, distTag, prerelease) => {
    expect(resolveCliRelease(tag)).toEqual({ tag, version, distTag, prerelease });
  });

  it("treats a numeric prerelease as a prerelease, not a stable release", () => {
    // `1.0.0-1` is a valid SemVer prerelease. The shell test this policy replaced looked for a
    // letter after the hyphen, so it called this stable and would have moved `latest`.
    expect(resolveCliRelease("v1.0.0-1")).toMatchObject({
      prerelease: true,
      distTag: CLI_PRERELEASE_DIST_TAG,
    });
  });

  it("never puts a prerelease on latest", () => {
    for (const tag of ["v0.1.0-beta.1", "v0.1.0-rc.1", "v1.0.0-1", "v9.9.9-x.y.z"]) {
      expect(resolveCliRelease(tag).distTag).not.toBe(CLI_STABLE_DIST_TAG);
    }
  });

  it("never puts a stable release on next", () => {
    for (const tag of ["v0.1.0", "v1.2.3", "v10.0.0"]) {
      expect(resolveCliRelease(tag).distTag).not.toBe(CLI_PRERELEASE_DIST_TAG);
    }
  });

  it("refuses the bootstrap placeholder, which is otherwise a well-formed prerelease", () => {
    expect(() => resolveCliRelease(`v${CLI_BOOTSTRAP_VERSION}`)).toThrow(CliReleaseError);
    expect(() => resolveCliRelease(`v${CLI_BOOTSTRAP_VERSION}`)).toThrow(
      new RegExp(`"${CLI_BOOTSTRAP_DIST_TAG}"`),
    );
  });

  it("refuses any bootstrap-identified version, not only the exact placeholder", () => {
    // The rule is the identifier, not the string: a second placeholder would be `0.0.0-bootstrap.1`.
    expect(() => resolveCliRelease("v0.0.0-bootstrap.1")).toThrow(CliReleaseError);
    expect(() => resolveCliRelease("v1.0.0-bootstrap")).toThrow(CliReleaseError);
  });

  it.each([
    ["sdk-v0.1.0-beta.2", "the SDK's own tag"],
    ["0.1.0-beta.1", "no v prefix"],
    ["vscode-extension-v1", "an unrelated tag the v* glob also matches"],
    ["v2-spike", "a branch-shaped tag"],
    ["v", "the prefix alone"],
    ["v0.1", "a two-part version"],
    ["v0.1.0.1", "a four-part version"],
    ["vlatest", "a channel name"],
    ["", "an empty tag"],
  ])("refuses %s (%s)", (tag) => {
    expect(() => resolveCliRelease(tag)).toThrow(CliReleaseError);
  });
});

describe("derived release names", () => {
  it("derives the tag, tarball, and spec from one version", () => {
    expect(cliReleaseTag("0.1.0-beta.1")).toBe(`${CLI_TAG_PREFIX}0.1.0-beta.1`);
    expect(cliTarballName("0.1.0-beta.1")).toBe("fairux-0.1.0-beta.1.tgz");
    expect(cliReleaseSpec("0.1.0-beta.1")).toBe("fairux@0.1.0-beta.1");
  });

  it("round-trips a tag through the version it names", () => {
    const tag = "v0.1.0-beta.1";
    expect(cliReleaseTag(resolveCliRelease(tag).version)).toBe(tag);
  });
});
