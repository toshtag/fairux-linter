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
  // A document that shows the heading format must not release a version by explaining how to, and
  // a heading nobody can see must not release one at all.
  ["an example inside a backtick fence", `\`\`\`markdown\n${CANONICAL}\n\`\`\``],
  ["an example inside a tilde fence", `~~~markdown\n${CANONICAL}\n~~~`],
  ["a heading inside an HTML comment", `<!--\n${CANONICAL}\n-->`],
  // A fence is closed by its own character, at least as long, with nothing after it. Comparing
  // prefixes let a shorter marker — and a marker with an info string — end a block it had not.
  ["a four-backtick fence a three closes", `\`\`\`\`markdown\n\`\`\`\n${CANONICAL}\n\`\`\`\``],
  ["a four-tilde fence a three closes", `~~~~markdown\n~~~\n${CANONICAL}\n~~~~`],
  ["a marker with text after it, taken for a closer", `\`\`\`md\n\`\`\`nope\n${CANONICAL}\n\`\`\``],
  // Raw HTML is refused outright rather than tracked. Each of these hid the heading from a reader
  // while the scanner counted it, and CommonMark names seven families of them.
  ["a heading inside <pre>", `<pre>\n${CANONICAL}\n</pre>`],
  ["a heading inside <div>", `<div>\n${CANONICAL}\n</div>`],
  ["a heading inside CDATA", `<![CDATA[\n${CANONICAL}\n]]>`],
  ["a heading inside a processing instruction", `<?\n${CANONICAL}\n?>`],
];

/** The same heading, shown as an example *and* written for real. The real one counts. */
const SHOWN_AND_WRITTEN: ReadonlyArray<readonly [string, string]> = [
  [
    "a fenced example beside the real entry",
    `\`\`\`markdown\n${CANONICAL}\n\`\`\`\n\n${CANONICAL}`,
  ],
  // The fence must reopen the file when it closes properly, or a document that shows the format
  // could never also use it. (An HTML-comment example has no counterpart here: raw HTML is refused
  // outright now, so there is no "beside the real entry" case for it to have.)
  [
    "a long fence, properly closed, beside the real entry",
    `\`\`\`\`markdown\n\`\`\`\n${CANONICAL}\n\`\`\`\`\n\n${CANONICAL}`,
  ],
  [
    "a closer longer than its opener, beside the real entry",
    `\`\`\`markdown\n${CANONICAL}\n\`\`\`\`\`\n\n${CANONICAL}`,
  ],
  [
    "an info string containing backticks, which opens nothing",
    `\`\`\` \`x\` \`\`\`\n\n${CANONICAL}`,
  ],
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

  it.each(SHOWN_AND_WRITTEN)("counts only the real entry when %s", (_label, replacement) => {
    const changelog = insteadOfTheEntry(replacement);
    expect(validateChangelogReleaseEntry(changelog, entry)).toEqual([]);
    // One, not two — otherwise the example would make a correct file look like a duplicate release.
    expect(releaseHeadings(changelog).filter((h) => h.version === manifest.version)).toHaveLength(
      1,
    );
  });

  it("reads a file written with CRLF line endings", () => {
    expect(validateChangelogReleaseEntry(CHANGELOG.replace(/\n/g, "\r\n"), entry)).toEqual([]);
  });

  it("records what changed, not merely the number", () => {
    // Moved from `release-changelog.test.ts`, whose own predicate this replaces. A changelog entry
    // that named a version and said nothing would satisfy every structural rule above.
    expect(CHANGELOG).toContain("Narrow the published SDK description");
    // And what did not change, which is the part a consumer reads a changelog to find out.
    expect(CHANGELOG).toContain("No change to the public API");
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
  const runAgainst = (changelog: string, ambient: NodeJS.ProcessEnv = process.env) => {
    const dir = mkdtempSync(join(tmpdir(), "fairux-changelog-"));
    try {
      const path = join(dir, "CHANGELOG.md");
      writeFileSync(path, changelog, "utf8");
      // Every release input the checker reads from the environment, not only the one that caught
      // this. `TARBALL` sends it to audit an archive, and `FAIRUX_RELEASE_CHECK_NPM` sends it to
      // the network — either would decide the exit code with the changelog having no part in it,
      // which is the shape of the bug the tag fallback already caused here once.
      const {
        GITHUB_REF_NAME: _ref,
        TARBALL: _tarball,
        FAIRUX_RELEASE_CHECK_NPM: _npm,
        ...env
      } = ambient;
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

  it("is zero whatever the surrounding environment asks the checker to do", () => {
    // A hostile ambient environment: a branch name where the tag goes, an archive that is not
    // there, and the registry check switched on. Each on its own would fail the run for a reason
    // the changelog had nothing to do with — and would have made every negative case below pass
    // while proving nothing, which is exactly what `GITHUB_REF_NAME` did on CI.
    const result = runAgainst(CHANGELOG, {
      ...process.env,
      GITHUB_REF_NAME: "some-branch",
      TARBALL: join(tmpdir(), "fairux-no-such-tarball.tgz"),
      FAIRUX_RELEASE_CHECK_NPM: "1",
    });
    expect(result.status, result.stdout + result.stderr).toBe(0);
    // And the registry branch did not run — asserted on what that branch prints, not on the
    // registry URL, which the checker names in its ordinary output whether or not it asks anything.
    expect(result.stdout + result.stderr).not.toMatch(/npm registry (reports|state)/);
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
