/**
 * Whether the changelog carries a release entry for a version — structurally, not by substring.
 *
 * The gate this replaces asked whether the file *contained* the package name beside the version.
 * Measured on `main` before it was changed, every one of these passed as a release entry:
 *
 *     The migration guide mentions @fairux/sdk 0.1.0-beta.3, but this is not a release entry.
 *     ### [@fairux/sdk 0.1.0-beta.3] — 2026-08-01        (a level-3 heading)
 *     - @fairux/sdk 0.1.0-beta.3 shipped                 (a bullet, inside Unreleased)
 *     ## [@fairux/sdk 0.1.0-beta.3]                      (no date)
 *     …the canonical heading, twice, with different dates
 *
 * A release gate that a sentence about a migration guide satisfies is a gate that is open. What it
 * is meant to establish is that somebody wrote the entry a consumer will read, so what it checks is
 * the entry: one level-2 heading, this package, this version, a date.
 *
 * Deliberately a line scanner rather than a Markdown parser. The heading form is fixed by
 * `CHANGELOG.md` and by the release runbook; a parser would accept more shapes than the file is
 * allowed to have, which is how the previous gate got wide.
 *
 * Exported so the checker and its tests share one definition. A test that re-implemented "looks
 * like a release heading" would pass while production accepted something else — the failure this
 * module exists to make impossible.
 */

/** The one shape a released section may take. `—` is an em dash, as in the file. */
export const RELEASE_HEADING = /^## \[(\S+) (\S+)\] — (\d{4}-\d{2}-\d{2})$/;

/** A date the calendar has, not merely one that matches the shape. */
function isRealDate(iso) {
  const parsed = new Date(`${iso}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === iso;
}

/**
 * Every level-2 release heading in `changelog`, in file order.
 *
 * `## [Unreleased]` does not match — it has no version and no date — which is the point: the
 * section a release is prepared in must not be able to stand in for the section it is released in.
 */
export function releaseHeadings(changelog) {
  const found = [];
  const lines = changelog.split(/\r?\n/);
  // The two places a line can look like a heading without being one. A document that shows the
  // heading format — this file's own module comment does — would otherwise release a version by
  // explaining how to, and an `<!-- … -->` heading is invisible to every reader but this scanner.
  //
  // Tracked rather than parsed. The fence is closed by a marker of the same kind, which is all
  // CommonMark needs here and all this file has ever used.
  let fence = null;
  let inComment = false;
  for (const [index, line] of lines.entries()) {
    if (inComment) {
      if (line.includes("-->")) inComment = false;
      continue;
    }
    if (fence) {
      if (line.trimStart().startsWith(fence)) fence = null;
      continue;
    }
    const opener = /^\s*(```|~~~)/.exec(line);
    if (opener) {
      fence = opener[1];
      continue;
    }
    if (line.includes("<!--") && !line.includes("-->")) {
      inComment = true;
      continue;
    }

    const match = RELEASE_HEADING.exec(line);
    if (match) {
      found.push({ line: index + 1, name: match[1], version: match[2], date: match[3] });
    }
  }
  return found;
}

/**
 * What is wrong with `changelog` as a record of releasing `name@version`, as a list.
 *
 * A list rather than a throw or a boolean, so the caller decides what a violation costs and the
 * tests can assert on which one was found. Empty means the entry is there and well-formed.
 */
export function validateChangelogReleaseEntry(changelog, { name, version }) {
  const violations = [];
  const headings = releaseHeadings(changelog);
  const mine = headings.filter((heading) => heading.name === name && heading.version === version);

  if (mine.length === 0) {
    const near = headings.filter((heading) => heading.name === name).map((h) => h.version);
    violations.push(
      `CHANGELOG.md has no released section for ${name} ${version}. ` +
        `Expected a line "## [${name} ${version}] — YYYY-MM-DD"` +
        (near.length > 0 ? `; it records ${name} ${near.join(", ")}` : "") +
        ". A mention in prose, a bullet, or a deeper heading is not a release entry.",
    );
    return violations;
  }
  if (mine.length > 1) {
    violations.push(
      `CHANGELOG.md has ${mine.length} released sections for ${name} ${version}, on lines ` +
        `${mine.map((heading) => heading.line).join(" and ")}. A version is released once.`,
    );
  }
  for (const heading of mine) {
    if (!isRealDate(heading.date)) {
      violations.push(
        `CHANGELOG.md line ${heading.line} dates ${name} ${version} "${heading.date}", ` +
          "which is not a date on the calendar.",
      );
    }
  }
  return violations;
}
