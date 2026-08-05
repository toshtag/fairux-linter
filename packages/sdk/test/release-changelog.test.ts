import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The changelog gate, and why it used to prove nothing.
 *
 * `release-check.mjs` accepted `changelog.includes(version) || changelog.includes("First public
 * release")`. The second half is generic prose that has been in the file since before the first
 * release, so **every** future version passed with no entry of its own — a gate that is permanently
 * open is worse than no gate, because a green check reads as a kept promise.
 *
 * The rule is now: the changelog must name this package and this version *together*. The version
 * alone is not enough — it could be the CLI's, or appear in an unrelated sentence.
 *
 * Checked here as a pure predicate over changelog text rather than by running the release check, so
 * a mutation can be tried without a build.
 */

const root = resolve(import.meta.dirname, "../../..");
const manifest = JSON.parse(readFileSync(resolve(root, "packages/sdk/package.json"), "utf8")) as {
  name: string;
  version: string;
};

/** The predicate `release-check.mjs` applies, mirrored so mutations can be exercised. */
function changelogRecordsSdkVersion(changelog: string, name: string, version: string): boolean {
  return (
    changelog.includes(`SDK ${version}`) ||
    changelog.includes(`${name} ${version}`) ||
    changelog.includes(`${name}@${version}`)
  );
}

describe("the changelog gate", () => {
  const changelog = readFileSync(resolve(root, "CHANGELOG.md"), "utf8");

  it("passes for the version this repository has prepared", () => {
    expect(changelogRecordsSdkVersion(changelog, manifest.name, manifest.version)).toBe(true);
  });

  it("records what changed, not merely the number", () => {
    expect(changelog).toContain("Narrow the published SDK description");
    // And what did not change, which is the part a consumer reads a changelog to find out.
    expect(changelog).toContain("No change to the public API");
  });

  /**
   * The mutations. Each is a way the old gate passed while the changelog said nothing about the
   * version being released.
   */
  it("fails when the entry for this version is removed", () => {
    // Every spelling the predicate accepts, not the one the entry happened to use when this was
    // written. It removed `SDK <version>` alone, so the day the entry became
    // `@fairux/sdk <version>` — the same statement, in the form the predicate lists second — the
    // mutation stopped removing anything and this case asserted nothing.
    const without = [
      `SDK ${manifest.version}`,
      `${manifest.name} ${manifest.version}`,
      `${manifest.name}@${manifest.version}`,
    ].reduce((text, spelling) => text.replaceAll(spelling, "(unreleased)"), changelog);
    expect(without, "the mutation must remove something").not.toBe(changelog);
    expect(changelogRecordsSdkVersion(without, manifest.name, manifest.version)).toBe(false);
  });

  it("fails on the generic first-release prose alone", () => {
    // The exact bypass that made the old gate permanently open.
    expect(
      changelogRecordsSdkVersion(
        "## [Unreleased]\n\nFirst public release in preparation.\n",
        manifest.name,
        manifest.version,
      ),
    ).toBe(false);
  });

  it("fails when only another package's release is recorded", () => {
    expect(
      changelogRecordsSdkVersion(
        `## [Unreleased]\n\n### CLI ${manifest.version}\n\n- something\n`,
        manifest.name,
        manifest.version,
      ),
    ).toBe(false);
  });

  it("fails when the version appears in unrelated prose", () => {
    // A bare version substring is not a changelog entry.
    expect(
      changelogRecordsSdkVersion(
        `The registry consumer smoke resolved ${manifest.version} on both Node floors.\n`,
        manifest.name,
        manifest.version,
      ),
    ).toBe(false);
  });

  it("accepts either the spec form or the prose form of the same statement", () => {
    for (const line of [
      `### SDK ${manifest.version}`,
      `### ${manifest.name} ${manifest.version}`,
      `Published \`${manifest.name}@${manifest.version}\`.`,
    ]) {
      expect(changelogRecordsSdkVersion(line, manifest.name, manifest.version), line).toBe(true);
    }
  });
});
