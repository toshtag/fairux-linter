import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
// The production predicate, not a copy of it. A test that re-implemented "looks like a release
// heading" would agree with itself while the checker accepted something else — which is exactly how
// the gate this replaces stayed open: the test asserted the substring search it was testing.
import {
  releaseHeadings,
  validateChangelogReleaseEntry,
} from "../scripts/changelog-release-entry.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const CHECKER = join(ROOT, "packages/sdk/scripts/release-check.mjs");
const CHANGELOG = readFileSync(join(ROOT, "CHANGELOG.md"), "utf8");
const manifest = JSON.parse(readFileSync(join(ROOT, "packages/sdk/package.json"), "utf8")) as {
  name: string;
  version: string;
};

const CANONICAL = `## [${manifest.name} ${manifest.version}] — 2026-08-01`;
const entry = { name: manifest.name, version: manifest.version };

/** The real changelog with its released section replaced by something else. */
function insteadOfTheEntry(replacement: string): string {
  const at = CHANGELOG.indexOf(CANONICAL);
  // A substitution that matched nothing would leave the file valid and prove nothing.
  expect(at, `the changelog no longer carries ${CANONICAL}`).toBeGreaterThan(0);
  return CHANGELOG.replace(CANONICAL, replacement);
}

/**
 * Every way of naming a version that is not releasing it.
 *
 * Each was measured passing the previous gate, which asked whether the file contained the package
 * name beside the version anywhere at all.
 */
const REFUSED: ReadonlyArray<readonly [string, string]> = [
  [
    "prose that mentions the version",
    `The migration guide mentions ${manifest.name} ${manifest.version}, but this is not an entry.`,
  ],
  ["a level-3 heading", `### [${manifest.name} ${manifest.version}] — 2026-08-01`],
  ["a bullet", `- ${manifest.name} ${manifest.version} shipped`],
  ["a heading with no date", `## [${manifest.name} ${manifest.version}]`],
  ["a date the calendar does not have", `## [${manifest.name} ${manifest.version}] — 2026-02-31`],
  ["another package's release", `## [@fairux/cli ${manifest.version}] — 2026-08-01`],
  ["another version's release", `## [${manifest.name} 9.9.9] — 2026-08-01`],
  [
    "the same release twice",
    `${CANONICAL}\n\n## [${manifest.name} ${manifest.version}] — 2026-01-01`,
  ],
  ["nothing at all", ""],
];

describe("what counts as a released section", () => {
  it("accepts the one this repository actually wrote", () => {
    expect(validateChangelogReleaseEntry(CHANGELOG, entry)).toEqual([]);
  });

  it.each(REFUSED)("refuses %s", (_label, replacement) => {
    const violations = validateChangelogReleaseEntry(insteadOfTheEntry(replacement), entry);
    expect(violations.length).toBeGreaterThan(0);
    // Named, so a reader is told which rule they broke rather than that something is wrong.
    expect(violations.join(" ")).toMatch(/CHANGELOG\.md/);
  });

  it("reads the heading rather than the file, so other releases may sit beside it", () => {
    const withHistory = `${CHANGELOG}\n\n## [${manifest.name} 0.1.0-beta.2] — 2026-07-27\n\n- older\n`;
    expect(validateChangelogReleaseEntry(withHistory, entry)).toEqual([]);
    expect(releaseHeadings(withHistory).map((heading) => heading.version)).toContain(
      "0.1.0-beta.2",
    );
  });

  it("does not treat the Unreleased section as a release", () => {
    // It has no version and no date; a section a release is *prepared* in must not stand in for the
    // section it is released in.
    expect(releaseHeadings("## [Unreleased]\n\n- something\n")).toEqual([]);
  });
});

/**
 * The other half, and the reason it is a separate layer.
 *
 * `release-check.mjs` used to funnel every check through one `assert` helper. Making that helper
 * return `ok()` unconditionally left the whole script passing on a changelog naming the wrong
 * version — measured, along with `test-packed-artifact-contract.mjs` passing too. Nothing detected
 * it, because nothing asserted on the *exit code*.
 *
 * These cases run the checker as a process. A mutation to its failure path fails them while the
 * cases above still pass, and a mutation to the predicate fails those while these still pass —
 * which is what makes the two layers independent rather than one check written twice.
 */
describe("the checker's exit code", () => {
  /**
   * The checker, with the changelog as the only thing that can decide its exit code.
   *
   * `--tag` and a scrubbed `GITHUB_REF_NAME` are both load-bearing. Without them the script takes
   * the tag from the environment, which on a CI runner is the branch — so it exits 1 for the tag
   * whatever the changelog says. The positive case caught that by going red on the first CI run;
   * the nine negative ones would have stayed green while proving nothing, which is the failure they
   * exist to prevent.
   */
  const runAgainst = (changelog: string) => {
    const dir = mkdtempSync(join(tmpdir(), "fairux-changelog-"));
    try {
      const path = join(dir, "CHANGELOG.md");
      writeFileSync(path, changelog, "utf8");
      const { GITHUB_REF_NAME: _ambient, ...env } = process.env;
      return spawnSync(
        "node",
        [CHECKER, "--changelog", path, "--tag", `sdk-v${manifest.version}`],
        { encoding: "utf8", timeout: 60_000, cwd: ROOT, env },
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  it("is zero for the changelog this repository has", () => {
    const result = runAgainst(CHANGELOG);
    expect(result.status, result.stdout + result.stderr).toBe(0);
  });

  it.each(REFUSED)("is non-zero for %s", (_label, replacement) => {
    const result = runAgainst(insteadOfTheEntry(replacement));
    expect(result.status, result.stdout + result.stderr).not.toBe(0);
    // And non-zero *for this reason*. An exit code alone is satisfied by a checker that failed on
    // the tag while the changelog gate did nothing — which is what happened on CI until the run
    // above pinned the tag.
    expect(result.stderr).toMatch(/CHANGELOG\.md/);
  });
});
