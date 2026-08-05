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
/** A fence opens on three or more of one character, indented no more than three spaces. */
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})(.*)$/;
/** …and closes on the same character, at least as long, with nothing after it but spaces. */
const FENCE_CLOSE = /^ {0,3}(`+|~+)[ \t]*$/;
/** A line that begins a raw HTML block, in any of the forms CommonMark gives that name. */
const RAW_HTML = /^ {0,3}</;

/**
 * One pass over the file: the headings it contains, and the raw HTML it is not allowed to contain.
 *
 * Both come from the same scan because the fence state decides each of them — a `<div>` inside a
 * code fence is an example, and a `## [...]` inside one is too.
 */
function scan(changelog) {
  const headings = [];
  const rawHtml = [];
  let fence = null;

  for (const [index, line] of changelog.split(/\r?\n/).entries()) {
    if (fence) {
      const closer = FENCE_CLOSE.exec(line);
      // Same character, and at least as long: ```` is not closed by ```, and a marker with an info
      // string after it is not a closer at all. Both of those passed when this compared prefixes.
      if (closer && closer[1][0] === fence.character && closer[1].length >= fence.length) {
        fence = null;
      }
      continue;
    }

    const opener = FENCE_OPEN.exec(line);
    // A backtick fence's info string may not contain a backtick, so ``` `x` ``` opens nothing.
    if (opener && !(opener[1][0] === "`" && opener[2].includes("`"))) {
      fence = { character: opener[1][0], length: opener[1].length };
      continue;
    }

    if (RAW_HTML.test(line)) {
      rawHtml.push(index + 1);
      continue;
    }

    const match = RELEASE_HEADING.exec(line);
    if (match) {
      headings.push({ line: index + 1, name: match[1], version: match[2], date: match[3] });
    }
  }
  return { headings, rawHtml };
}

/**
 * Every level-2 release heading in `changelog`, in file order.
 *
 * Lines inside a code fence are not headings — a document that shows this format would otherwise
 * release a version by explaining how to. Neither is anything inside raw HTML, which
 * {@link validateChangelogReleaseEntry} refuses outright rather than tracking: emulating
 * CommonMark's HTML blocks means accepting more shapes than this file is allowed to have, which is
 * how the substring gate before it got wide.
 */
export function releaseHeadings(changelog) {
  return scan(changelog).headings;
}

/**
 * What is wrong with `changelog` as a record of releasing `name@version`, as a list.
 *
 * A list rather than a throw or a boolean, so the caller decides what a violation costs and the
 * tests can assert on which one was found. Empty means the entry is there and well-formed.
 */
export function validateChangelogReleaseEntry(changelog, { name, version }) {
  const violations = [];
  const { headings, rawHtml } = scan(changelog);

  // Refused rather than parsed. `<pre>`, `<div>`, `<![CDATA[`, and a processing instruction all hid
  // a canonical heading from a reader while this scanner counted it, and CommonMark names seven
  // families of HTML block — a partial imitation of them would keep that door open at whichever
  // form it did not implement. This file has no raw HTML in it, so the rule costs nothing and the
  // door has no forms left.
  if (rawHtml.length > 0) {
    violations.push(
      `CHANGELOG.md has raw HTML on line ${rawHtml.join(", ")}. This file is Markdown without it, ` +
        "because a release heading inside an HTML block is one no reader can see.",
    );
  }

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
