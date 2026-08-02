import { describe, expect, it } from "vitest";
import {
  auditExistingCliRelease,
  CLI_RELEASE_VIEW_FIELDS,
} from "../../apps/cli/scripts/cli-github-release-contract.mjs";

/**
 * What an existing GitHub Release must already be, before a rerun edits it.
 *
 * The step said "create or repair", and the repair half promised more than it could do.
 * `gh release edit --latest` does not clear a `prerelease` flag, so a Release created — by hand, or
 * by an earlier run that classified it differently — as a prerelease stays one. The edit either
 * fails or succeeds with the classification still wrong, and either way the run reported a repaired
 * Release.
 *
 * Repair is now scoped to notes, title, and assets on a Release that is *already* classified the
 * way this release is. Silently reclassifying would be worse than failing: the prerelease flag
 * decides whether GitHub presents a Release as the current one, so flipping it unasked is a
 * publication decision. Deleting and recreating is not the alternative either — that discards
 * download counts and reactions on something already public.
 */

const TAG = "v0.1.0-beta.1";

const release = (overrides: Record<string, unknown> = {}) => ({
  tagName: TAG,
  isDraft: false,
  isPrerelease: true,
  ...overrides,
});

describe("auditExistingCliRelease", () => {
  it("accepts a published prerelease on the right tag", () => {
    expect(
      auditExistingCliRelease({
        expectedTag: TAG,
        expectedPrerelease: true,
        release: release(),
      }),
    ).toEqual([]);
  });

  it("accepts a published stable release when a stable release is being made", () => {
    expect(
      auditExistingCliRelease({
        expectedTag: "v1.0.0",
        expectedPrerelease: false,
        release: release({ tagName: "v1.0.0", isPrerelease: false }),
      }),
    ).toEqual([]);
  });

  it("refuses a Release on another tag", () => {
    expect(
      auditExistingCliRelease({
        expectedTag: TAG,
        expectedPrerelease: true,
        release: release({ tagName: "v0.1.0-beta.2" }),
      }),
    ).toEqual([expect.stringContaining("is on tag v0.1.0-beta.2, not v0.1.0-beta.1")]);
  });

  it("refuses a draft, which repairing would publish as a side effect", () => {
    const failures = auditExistingCliRelease({
      expectedTag: TAG,
      expectedPrerelease: true,
      release: release({ isDraft: true }),
    });
    expect(failures).toEqual([expect.stringContaining("is a draft")]);
    expect(failures[0]).toContain("docs/maintainers/release-cli.md");
  });

  it("refuses a prerelease Release for a stable release", () => {
    // The case `gh release edit --latest` cannot fix, and the reason repair is scoped.
    const failures = auditExistingCliRelease({
      expectedTag: "v1.0.0",
      expectedPrerelease: false,
      release: release({ tagName: "v1.0.0", isPrerelease: true }),
    });
    expect(failures).toEqual([expect.stringContaining("is marked prerelease")]);
    expect(failures[0]).toContain("cannot clear a prerelease flag");
  });

  it("refuses a stable Release for a prerelease", () => {
    expect(
      auditExistingCliRelease({
        expectedTag: TAG,
        expectedPrerelease: true,
        release: release({ isPrerelease: false }),
      }),
    ).toEqual([expect.stringContaining("is marked latest")]);
  });

  it.each(["tagName", "isDraft", "isPrerelease"])("refuses a missing %s", (field) => {
    const incomplete = release();
    delete (incomplete as Record<string, unknown>)[field];
    expect(
      auditExistingCliRelease({ expectedTag: TAG, expectedPrerelease: true, release: incomplete }),
    ).toEqual([expect.stringContaining(field)]);
  });

  it("refuses a flag that is not a boolean rather than coercing it", () => {
    // `undefined !== true` would have read an unknown Release as a published stable one.
    for (const isPrerelease of ["true", 1, null]) {
      expect(
        auditExistingCliRelease({
          expectedTag: TAG,
          expectedPrerelease: true,
          release: release({ isPrerelease }),
        }),
      ).toEqual([expect.stringContaining("has no isPrerelease flag")]);
    }
  });

  it("refuses a response that is not an object", () => {
    for (const value of [null, [], "release", 1]) {
      expect(
        auditExistingCliRelease({ expectedTag: TAG, expectedPrerelease: true, release: value }),
      ).toEqual(["gh release view did not return an object"]);
    }
  });

  it("reports every problem at once", () => {
    expect(
      auditExistingCliRelease({
        expectedTag: TAG,
        expectedPrerelease: true,
        release: release({ tagName: "v9.9.9", isDraft: true, isPrerelease: false }),
      }),
    ).toHaveLength(3);
  });

  it("names exactly the fields the entrypoint asks GitHub for", () => {
    // The query and the contract read the same three fields; naming them once keeps a field that
    // is checked but not requested from silently reading as absent.
    expect([...CLI_RELEASE_VIEW_FIELDS]).toEqual(["tagName", "isDraft", "isPrerelease"]);
  });
});
