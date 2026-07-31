import { describe, expect, it } from "vitest";
import {
  classifyVersion,
  compareVersions,
  distTagFor,
  firstPrereleaseIdentifier,
  isBetaPrerelease,
  isBootstrapPrerelease,
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

describe("isBootstrapPrerelease", () => {
  /**
   * The name-reservation placeholder. It exists because an npm Trusted Publisher record is
   * configured on a package's own settings page, so a package that does not exist yet cannot have
   * one — the name is created by a manual publish first.
   */
  it.each(["0.0.0-bootstrap.0", "0.0.0-bootstrap.1", "1.0.0-bootstrap", "0.1.0-bootstrap.rc.1"])(
    "identifies %s",
    (version) => {
      expect(isBootstrapPrerelease(version)).toBe(true);
    },
  );

  it.each(["0.1.0-beta.1", "0.1.0-rc.1", "0.0.0", "1.0.0", "0.1.0-bootstrapped.1"])(
    "does not identify %s",
    (version) => {
      expect(isBootstrapPrerelease(version)).toBe(false);
    },
  );

  it("is invisible to the dist-tag policy, which is why callers must ask it separately", () => {
    // The trap this guards: nothing about the placeholder's shape marks it as unpublishable, so
    // the repository-wide policy routes it onto the beta channel like any other prerelease.
    expect(distTagFor("0.0.0-bootstrap.0")).toBe("next");
    expect(classifyVersion("0.0.0-bootstrap.0")).toEqual({ valid: true, prerelease: true });
  });

  it("ignores build metadata, like the other identifier tests", () => {
    expect(isBootstrapPrerelease("1.0.0+bootstrap")).toBe(false);
  });
});

describe("compareVersions", () => {
  /**
   * A dist-tag is a channel: it may advance and must not go backwards, which is a comparison
   * rather than an equality. Without one, the CLI's channel policy could only be expressed for a
   * package that had never been released — "`next` must not exist" made the first beta correct and
   * every release after it impossible.
   */
  it.each([
    ["0.1.0-beta.1", "0.1.0-beta.2"],
    ["0.1.0-beta.2", "0.1.0-beta.10"],
    ["0.1.0-beta.2", "0.1.0-rc.1"],
    ["0.1.0-rc.1", "0.1.0"],
    ["0.1.0", "0.2.0-beta.1"],
    ["0.1.0", "0.1.1"],
    ["0.9.9", "1.0.0"],
    ["1.0.0-alpha", "1.0.0-alpha.1"],
    ["1.0.0-alpha.1", "1.0.0-alpha.beta"],
    ["1.0.0-alpha.beta", "1.0.0-beta"],
    ["1.0.0-beta.2", "1.0.0-beta.11"],
    ["1.0.0-rc.1", "1.0.0"],
    ["0.0.0-bootstrap.0", "0.1.0-beta.1"],
  ])("orders %s before %s", (lower, higher) => {
    expect(compareVersions(lower, higher)).toBe(-1);
    expect(compareVersions(higher, lower)).toBe(1);
  });

  it("ranks a stable version above a prerelease of the same core", () => {
    // The one that is easy to get backwards, and the one the channel policy depends on: `latest`
    // holding `1.0.0` means `1.0.0-beta.1` is *older*, not newer.
    expect(compareVersions("1.0.0", "1.0.0-beta.1")).toBe(1);
    expect(compareVersions("1.0.0-beta.1", "1.0.0")).toBe(-1);
  });

  it("ranks a numeric identifier below a non-numeric one", () => {
    // Kind before value, per §11: `1.0.0-2` precedes `1.0.0-alpha` even though 2 > "a" lexically.
    expect(compareVersions("1.0.0-2", "1.0.0-alpha")).toBe(-1);
    expect(compareVersions("1.0.0-2", "1.0.0-11")).toBe(-1);
  });

  it("ignores build metadata", () => {
    expect(compareVersions("1.0.0+one", "1.0.0+two")).toBe(0);
    expect(compareVersions("1.0.0", "1.0.0+build")).toBe(0);
    expect(compareVersions("0.1.0-beta.1+a", "0.1.0-beta.1+b")).toBe(0);
  });

  it("reports equality for the same version", () => {
    expect(compareVersions("0.1.0-beta.1", "0.1.0-beta.1")).toBe(0);
    expect(compareVersions("1.2.3", "1.2.3")).toBe(0);
  });

  it("compares numeric identifiers past the double's exact range", () => {
    // `Number()` rounds these two to the same value. The core comparison reported them equal, and
    // as prerelease identifiers the equality fell through to the "greater" branch and called the
    // lower one higher. SemVer bounds no numeric identifier's length.
    expect(compareVersions("9007199254740992.0.0", "9007199254740993.0.0")).toBe(-1);
    expect(compareVersions("9007199254740993.0.0", "9007199254740992.0.0")).toBe(1);
    expect(compareVersions("1.0.0-9007199254740992", "1.0.0-9007199254740993")).toBe(-1);
    expect(compareVersions("1.0.0-9007199254740993", "1.0.0-9007199254740992")).toBe(1);
  });

  it.each([
    ["a huge major", "9007199254740992.0.0", "9007199254740993.0.0"],
    ["a huge minor", "1.9007199254740992.0", "1.9007199254740993.0"],
    ["a huge patch", "1.0.9007199254740992", "1.0.9007199254740993"],
    ["differing digit counts", "999999999999999999.0.0", "1000000000000000000.0.0"],
    ["far past any double", "1.0.0-99999999999999999999999", "1.0.0-99999999999999999999999999"],
    ["a beta identifier past 2^53", "1.0.0-beta.9007199254740992", "1.0.0-beta.9007199254740993"],
  ])("orders %s correctly", (_label, lower, higher) => {
    expect(compareVersions(lower, higher)).toBe(-1);
    expect(compareVersions(higher, lower)).toBe(1);
  });

  it("reports huge equal versions as equal", () => {
    expect(compareVersions("9007199254740993.0.0", "9007199254740993.0.0")).toBe(0);
    expect(
      compareVersions("1.0.0-beta.99999999999999999999", "1.0.0-beta.99999999999999999999"),
    ).toBe(0);
  });

  it("does not compare digit strings lexically when their lengths differ", () => {
    // `"9" > "10"` lexically. Length has to be consulted first, which is sound only because the
    // grammar rejects leading zeros.
    expect(compareVersions("9.0.0", "10.0.0")).toBe(-1);
    expect(compareVersions("1.0.0-9", "1.0.0-10")).toBe(-1);
  });

  it("returns null rather than guessing at input that is not SemVer", () => {
    for (const [left, right] of [
      ["not-a-version", "1.0.0"],
      ["1.0.0", "latest"],
      ["1.0", "1.0.0"],
      ["", "1.0.0"],
    ]) {
      expect(compareVersions(left as string, right as string)).toBeNull();
    }
    expect(compareVersions(undefined as never, "1.0.0")).toBeNull();
  });
});
