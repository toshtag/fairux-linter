#!/usr/bin/env node
/**
 * Every `pnpm <script>` and repository path a document names in backticks still exists.
 *
 * The link checker covers markdown links. It does not cover the two things documents name most
 * often — a command to run and a file to look at — so both survived being removed: docs went on
 * telling readers to run `pnpm rules:reviews:check:approved` and to read
 * `packages/rules/reviews/maintainer-approval.json` after neither existed.
 *
 * That failure has a shape worth naming: a position statement goes stale because nobody re-reads it
 * while changing what it describes. Five such claims were corrected by hand once somebody thought to
 * look. This is the same re-reading, done on every run.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Documents to read: every `.md` under `docs/`, plus the ones at the root and beside the corpus. */
const EXTRA_DOCS = ["README.md", "CONTRIBUTING.md", "SECURITY.md", "corpus/README.md"];

/**
 * Named exceptions, each with the reason it is not a stale reference.
 *
 * An allowlist rather than a looser pattern: every entry here is a decision somebody can disagree
 * with, and a rule broad enough to cover them silently would cover a real regression too.
 */
const ALLOWED = new Map([
  ["packages/not-a-workspace/dist/", "an example of a path the build-output contract must reject"],
  ["packages/core/src/dist/", "the same, one level in"],
  ["docs/dist/", "the same, outside a workspace"],
]);

/** `pnpm` invocations that are not repository scripts. */
const PNPM_BUILTINS = new Set(["exec", "install", "dlx", "why", "add", "remove", "run", "-r"]);

/**
 * Prose that describes an issue as unfinished.
 *
 * A closed issue written up as pending is how a roadmap misleads without saying anything false at the
 * time. Two survived here — #104 described as "open rather than done" and #69 as closing later — both
 * completed months before anyone re-read the paragraph.
 *
 * Catching it needs the issue's state, which needs the network — and the offline half of this script
 * runs on every commit, where a network call is a flake waiting to happen. So it is a flag:
 * `--issues` asks GitHub, and the default run does not. Documented in CONTRIBUTING beside the docs
 * checklist, which is where the person editing a paragraph about an issue actually is.
 */
/** Characters either side of an issue reference that count as "about this issue". */
const PROXIMITY = 160;

const PENDING_PHRASES =
  /\b(?:is open|stays open|open rather than done|not (?:yet )?done|still (?:open|pending)|waiting on|closes after|blocked on|depends on|needs)\b/i;

/**
 * A heading that says the section below it is unfinished.
 *
 * Three references to the closed #133 survived the proximity window. `stays open` above is one of
 * them. Another sat under `## Not implemented yet` and said nothing unfinished of its own — it did
 * not have to, because a heading is a sentence every paragraph under it inherits, and it is further
 * away than 160 characters.
 *
 * The third, a bullet in the corpus's `## Scope` list, this still does not catch, and widening it
 * until it does would flag every scope list in the repository. Two of the three would have been
 * caught; the remaining one was found by reading, which is the only thing that found any of them.
 *
 * Both additions are the noisier half of the audit. Together they took the report from two
 * candidates to five on the tree that added them, and none of the three new ones is a finding —
 * #134 sits in the paragraph that says "stays open" about #203, and #126 and #135 are closed issues
 * correctly written up as answered, under a heading about what is not implemented. They earn their
 * place by what they would have caught, not by their hit rate, which is why this reports and the
 * offline half of the script is what fails a build.
 */
const UNFINISHED_HEADING =
  /^#{2,6}\s.*\b(?:not implemented|not yet|open items?|remaining|unfinished|what is left)\b/i;

const TOP_LEVEL = "packages|apps|scripts|corpus|docs|tests|examples|\\.github";
const PATH_PATTERN = new RegExp(`\`((?:${TOP_LEVEL})/[A-Za-z0-9_./@-]+)\``, "g");
const PNPM_PATTERN = /`pnpm ([a-z0-9:@._-]+)/g;

function markdownFiles() {
  const found = [];
  const walk = (dir) => {
    for (const entry of readdirSync(join(ROOT, dir))) {
      const relative = `${dir}/${entry}`;
      if (statSync(join(ROOT, relative)).isDirectory()) walk(relative);
      else if (relative.endsWith(".md")) found.push(relative);
    }
  };
  walk("docs");
  return [...found, ...EXTRA_DOCS].filter((file) => existsSync(join(ROOT, file)));
}

/** The last heading at or above `index` — the sentence the paragraph there inherits. */
function nearestHeading(text, index) {
  let heading = "";
  for (const match of text.matchAll(/^#{2,6}\s.*$/gm)) {
    if (match.index > index) break;
    heading = match[0];
  }
  return heading;
}

const scripts = new Set(
  Object.keys(JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).scripts ?? {}),
);
const failures = [];
const candidates = [];
let checked = 0;

for (const file of markdownFiles()) {
  const text = readFileSync(join(ROOT, file), "utf8");

  for (const match of text.matchAll(PNPM_PATTERN)) {
    const name = match[1];
    checked += 1;
    if (PNPM_BUILTINS.has(name) || scripts.has(name)) continue;
    failures.push(`${file}: \`pnpm ${name}\` is not a script in package.json`);
  }

  for (const match of text.matchAll(PATH_PATTERN)) {
    const path = match[1];
    if (path.includes("*")) continue;
    checked += 1;
    if (ALLOWED.has(path) || existsSync(join(ROOT, path))) continue;
    failures.push(`${file}: \`${path}\` does not exist`);
  }
}

if (process.argv.includes("--issues")) {
  const { execFileSync } = await import("node:child_process");
  const paragraphs = [];
  for (const file of markdownFiles()) {
    const text = readFileSync(join(ROOT, file), "utf8");
    for (const match of text.matchAll(/fairux-linter\/issues\/(\d+)/g)) {
      // A window around the reference rather than the paragraph it sits in. The paragraph was too
      // coarse — one bullet list produced eleven candidates and one real finding, and a report
      // nobody reads is the same as no report. A sentence is too tight: #69's reference and its
      // "closes after" were in different ones.
      const start = Math.max(0, match.index - PROXIMITY);
      const window = text.slice(start, match.index + PROXIMITY);
      const heading = nearestHeading(text, match.index);
      if (!PENDING_PHRASES.test(window) && !UNFINISHED_HEADING.test(heading)) continue;
      paragraphs.push({
        file,
        issue: match[1],
        block: window.replace(/\s+/g, " ").slice(0, 140),
        under: UNFINISHED_HEADING.test(heading) ? heading.trim() : null,
      });
    }
  }
  for (const entry of paragraphs) {
    let state = "UNKNOWN";
    try {
      state = execFileSync(
        "gh",
        ["issue", "view", entry.issue, "--json", "state", "-q", ".state"],
        {
          cwd: ROOT,
          encoding: "utf8",
        },
      ).trim();
    } catch {
      candidates.push(`${entry.file}: cannot read the state of #${entry.issue}`);
      continue;
    }
    if (state === "CLOSED") {
      const why = entry.under
        ? `it sits under "${entry.under}"`
        : "its paragraph reads as unfinished";
      candidates.push(`${entry.file}: #${entry.issue} is closed, and ${why} — "${entry.block}…"`);
    }
  }
  console.log(
    `  --issues: ${paragraphs.length} paragraph(s) pair an issue with unfinished-sounding wording; ` +
      `${candidates.length} name a closed one`,
  );
  for (const candidate of candidates) console.log(`    ? ${candidate}`);
  if (candidates.length > 0) {
    console.log("\n  Read them. A closed issue written up as pending is how a roadmap misleads");
    console.log("  without having said anything false at the time.");
  }
}

if (failures.length > 0) {
  console.error("✖ Documents name things that are not there:\n");
  for (const failure of failures) console.error(`  ${failure}`);
  console.error(
    "\nUpdate the document, or — if the reference is deliberately illustrative — add it to\n" +
      "ALLOWED in scripts/check-doc-references.mjs with the reason.",
  );
  process.exit(1);
}

console.log(`✓ ${checked} command and path references in documents all resolve`);
