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
 * Directories whose documents record what was true at the time and must not be rewritten.
 *
 * A closed review packet naming a file that has since been removed is accurate history. Editing it to
 * match today would destroy the record it exists to be.
 */
const HISTORICAL_DIRS = ["docs/reviews"];

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

const scripts = new Set(
  Object.keys(JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).scripts ?? {}),
);
const failures = [];
let checked = 0;

for (const file of markdownFiles()) {
  if (HISTORICAL_DIRS.some((dir) => file.startsWith(`${dir}/`))) continue;
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

if (failures.length > 0) {
  console.error("✖ Documents name things that are not there:\n");
  for (const failure of failures) console.error(`  ${failure}`);
  console.error(
    "\nUpdate the document, or — if the reference is deliberately historical or illustrative —\n" +
      "add it to HISTORICAL_DIRS or ALLOWED in scripts/check-doc-references.mjs with the reason.",
  );
  process.exit(1);
}

console.log(`✓ ${checked} command and path references in documents all resolve`);
