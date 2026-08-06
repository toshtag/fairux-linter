import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
// The production predicate, not a copy. A test that re-implemented "looks like a release heading"
// would agree with itself while the checker accepted something else.
import {
  type ReleaseHeading,
  releaseHeadings,
} from "../../packages/sdk/scripts/changelog-release-entry.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const CHANGELOG = readFileSync(resolve(ROOT, "CHANGELOG.md"), "utf8");

const UNRELEASED = "## [Unreleased]";

/** Every line of a section, from its heading to the next level-2 heading. */
function sectionOf(document: string, heading: string): string {
  const start = document.indexOf(heading);
  expect(start, `the changelog no longer carries ${heading}`).toBeGreaterThanOrEqual(0);
  const rest = document.slice(start + heading.length);
  const next = rest.search(/^## /m);
  return next === -1 ? rest : rest.slice(0, next);
}

/**
 * A released section has to keep saying what it said on the day.
 *
 * `[Unreleased]` is where the *next* release accumulates. A released section that points at it and
 * says "what this version ships" is a release note that changes every week after the release — and
 * it did: the `fairux 0.1.0-beta.1` entry described the CLI by delegating to `[Unreleased]`, and
 * eight pull requests of behaviour landed there before anybody noticed the entry now described a
 * tree that version never contained.
 *
 * The rule is narrow on purpose. A released section may *mention* `[Unreleased]` — explaining why
 * its own notes were moved out of it is exactly the sentence this repository needed to write. What
 * it may not do is delegate: hand a reader to a moving section for the substance of what shipped.
 */
describe("a released changelog section is a fixed record", () => {
  // `releaseHeadings` returns the parsed heading, not its text. The text is what a section starts
  // with, so it is rebuilt from the parts rather than re-matched with a second regex.
  const released: ReleaseHeading[] = releaseHeadings(CHANGELOG);
  const textOf = (heading: ReleaseHeading) =>
    `## [${heading.name} ${heading.version}] — ${heading.date}`;

  it("has released sections at all, so the rest of this file is not vacuous", () => {
    expect(released.length).toBeGreaterThanOrEqual(2);
    expect(
      released.some((heading) => heading.name === "fairux" && heading.version === "0.1.0-beta.1"),
    ).toBe(true);
  });

  it("never sends a reader to Unreleased for what a version shipped", () => {
    // The shape of the sentence that was there: a reference to the moving section, in the same
    // breath as a claim about what this release is or ships or contains.
    const delegating =
      /(?:is|are|was|were|ships?|shipped|contains?|carried|described?) [^.\n]{0,80}\[?Unreleased\]?(?: section)?|\[?Unreleased\]?(?: section)?[^.\n]{0,40}(?:which|that) this (?:release|version) ships/i;

    for (const heading of released) {
      const body = sectionOf(CHANGELOG, textOf(heading));
      const offending = body
        .split("\n")
        .filter((line) => delegating.test(line))
        // The one honest use: saying that these notes used to live there and why they were moved.
        .filter((line) => !/used to|moved|no longer|accumulat/i.test(line));
      expect(
        offending,
        `${textOf(heading)} delegates to ${UNRELEASED}: ${offending.join(" | ")}`,
      ).toEqual([]);
    }
  });

  it("describes each released version inside its own section", () => {
    // Not merely "does not delegate" — a section that says nothing is not a record either.
    for (const heading of released) {
      const body = sectionOf(CHANGELOG, textOf(heading));
      expect(body.trim().length, `${textOf(heading)} has no notes of its own`).toBeGreaterThan(400);
    }
  });

  it("keeps Unreleased for what is not released", () => {
    const unreleased = sectionOf(CHANGELOG, UNRELEASED);
    // It exists and it does not carry a released heading of its own. Its *content* is no longer
    // pinned here: this rule is about the boundary, and a release empties the section by moving
    // what accumulated into a fixed one — which is the boundary working, not a violation of it.
    expect(unreleased.trim().length).toBeGreaterThan(0);
    expect(releaseHeadings(`${UNRELEASED}${unreleased}`)).toEqual([]);
  });

  it("records the changes this beta accumulated, by the names a consumer would search for", () => {
    // Named individually rather than counted: each is a public surface a consumer meets, and a
    // changelog that summarises them into "various improvements" is one nobody can act on.
    //
    // Read across the two sections this release split them into rather than out of `[Unreleased]`,
    // where they were while unpublished. Which section each belongs to is
    // `changelog-package-scope`'s question; this one only asks that none of them was lost on the
    // way into a released record.
    const unreleased =
      sectionOf(CHANGELOG, "## [fairux 0.1.0-beta.2] — 2026-08-06") +
      sectionOf(CHANGELOG, "## [@fairux/sdk 0.1.0-beta.4] — 2026-08-06");
    for (const name of [
      "externalFilters",
      "AppliedSuppression.fingerprint",
      "FairUxInputReport",
      "FairUxReportInput",
      "SourceLocation.endLine",
      "figmaFile",
      "--stdin-filename",
      "--ignore-config",
      "overlapping-edits",
      "smoke:chrome",
      "smoke:vscode",
    ]) {
      expect(unreleased, `${UNRELEASED} does not mention ${name}`).toContain(name);
    }
  });

  it("keeps the one breaking change marked as one", () => {
    // Exiting 2 where three commands used to run is breaking for a script that passed both flags.
    // A beta may break; a beta that breaks quietly may not. In the CLI's released section now,
    // because that is the package it breaks.
    const cli = sectionOf(CHANGELOG, "## [fairux 0.1.0-beta.2] — 2026-08-06");
    expect(cli).toMatch(/\*\*Breaking for a script that passed both\*\*/);
  });

  it("does not present duplicate-edits as something a consumer lost", () => {
    // It was added and removed inside this beta and never published, so calling it a breaking
    // change would invent a contract nobody ever had.
    const cli = sectionOf(CHANGELOG, "## [fairux 0.1.0-beta.2] — 2026-08-06");
    const at = cli.indexOf("duplicate-edits");
    expect(at, "duplicate-edits should still be noted as development history").toBeGreaterThan(0);
    expect(cli.slice(at - 400, at + 400)).toMatch(
      /[Nn]o published version ever carried it|never (?:in a published version|published)/,
    );
  });
});
