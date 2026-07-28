import { describe, expect, it } from "vitest";
import {
  classifyVersion,
  distTagFor,
  firstPrereleaseIdentifier,
  isBetaPrerelease,
} from "../../scripts/release-version-contract.mjs";

/**
 * The release workflows used `[[ "$V" =~ -[a-zA-Z] ]]` to decide "is this a prerelease". SemVer
 * prerelease identifiers may be purely numeric, so `1.0.0-1` was classified as stable and would
 * have been published to `latest`.
 */

describe("version classification", () => {
  it.each([
    ["1.0.0", false],
    ["0.1.0", false],
    ["0.0.0", false],
    ["1.0.0+build.1", false],
    ["1.0.0-beta.1", true],
    ["0.1.0-beta.2", true],
    ["1.0.0-rc.1", true],
    ["1.0.0-alpha", true],
    ["1.0.0-1", true],
    ["1.0.0-0", true],
    ["1.0.0-0.3.7", true],
    ["1.0.0-x.7.z.92", true],
    ["1.0.0-1+build.5", true],
  ])("classifies %s", (version, prerelease) => {
    expect(classifyVersion(version)).toEqual({ valid: true, prerelease });
  });

  it.each([
    "",
    "1",
    "1.0",
    "1.0.0.0",
    "v1.0.0",
    "01.0.0",
    "1.01.0",
    "1.0.0-",
    "1.0.0-01",
    "1.0.0-beta_1",
    " 1.0.0",
    "1.0.0 ",
    "1.0.0\n",
    "latest",
  ])("refuses %j", (version) => {
    expect(classifyVersion(version)).toEqual({ valid: false, prerelease: false });
    expect(distTagFor(version)).toBeNull();
  });

  it("refuses a non-string", () => {
    expect(classifyVersion(undefined as unknown as string).valid).toBe(false);
  });

  it("maps a numeric prerelease to next, not latest", () => {
    expect(distTagFor("1.0.0-1")).toBe("next");
    expect(distTagFor("1.0.0")).toBe("latest");
    expect(distTagFor("0.1.0-beta.2")).toBe("next");
  });

  it("does not match a version embedded in a longer string", () => {
    // Anchored: an unanchored pattern would accept a tag ref or a shell-bearing value.
    expect(classifyVersion("1.0.0; rm -rf /").valid).toBe(false);
    expect(classifyVersion("prefix-1.0.0").valid).toBe(false);
  });
});

describe("beta prerelease identity", () => {
  it.each(["0.1.0-beta", "0.1.0-beta.1", "0.1.0-beta.2", "9.9.9-beta.42"])(
    "accepts %s",
    (version) => {
      expect(isBetaPrerelease(version)).toBe(true);
    },
  );

  it.each(["0.1.0-alpha.1", "0.1.0-rc.1", "0.1.0-1", "1.0.0", "beta", "0.1.0-betamax.1"])(
    "refuses %s",
    (version) => {
      expect(isBetaPrerelease(version)).toBe(false);
    },
  );

  it("ignores build metadata", () => {
    // `1.0.0+beta` is a stable version carrying a build tag, not a beta.
    expect(isBetaPrerelease("0.1.0-beta.2+build.1")).toBe(true);
    expect(isBetaPrerelease("1.0.0+beta")).toBe(false);
    expect(firstPrereleaseIdentifier("1.0.0+beta")).toBeNull();
  });

  it("reports the identifier itself, or null for a stable version", () => {
    expect(firstPrereleaseIdentifier("0.1.0-rc.1")).toBe("rc");
    expect(firstPrereleaseIdentifier("0.1.0-1")).toBe("1");
    expect(firstPrereleaseIdentifier("1.0.0")).toBeNull();
    expect(firstPrereleaseIdentifier("not a version")).toBeNull();
  });

  it("leaves the repository-wide dist-tag policy alone", () => {
    // `distTagFor` governs the CLI too, where an rc on `next` is correct. The SDK's beta
    // restriction is an extra gate, not a change to this policy.
    expect(distTagFor("0.1.0-rc.1")).toBe("next");
    expect(classifyVersion("0.1.0-rc.1")).toEqual({ valid: true, prerelease: true });
  });
});
