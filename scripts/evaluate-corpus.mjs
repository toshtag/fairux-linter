#!/usr/bin/env node
/**
 * Measure the built-in rule set against the labelled corpus.
 *
 * The labels say what each page *should* produce, decided from the page. When the engine disagrees,
 * the disagreement is what gets recorded — a label is never edited to match the output, because a
 * corpus whose labels come from the output measures nothing at all.
 *
 * Two modes, matching the rule catalog's: `--write` regenerates the artifacts, `--check` fails when
 * the committed ones do not match what this run produced. The point of committing them is that a
 * change in detection quality shows up in a diff instead of in someone's memory.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
// The built output, like every other generator here: this measures what the packages actually
// produce, not what their sources would produce under a test runner's transform.
import { createScanner } from "../packages/core/dist/index.js";
import { parseHtml } from "../packages/html/dist/index.js";
import { dictionary, fairuxBuiltinRulePack } from "../packages/rules/dist/index.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CORPUS_DIR = join(ROOT, "corpus");
const MANIFEST_PATH = join(CORPUS_DIR, "manifest.json");
const JSON_ARTIFACT = join(ROOT, "docs/generated/corpus-evaluation.json");
const MARKDOWN_ARTIFACT = join(ROOT, "docs/generated/corpus-evaluation.md");

const DISCLAIMER =
  "These numbers describe this corpus. They are not an accuracy claim about pages nobody here has seen.";

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

/**
 * Every case is scanned by one scanner, built once.
 *
 * The corpus measures the rule set a default scan runs. Experimental rules are default-off and
 * their review records are prepared rather than approved, so measuring them here would report a
 * quality number for something no user runs.
 */
function createCorpusScanner() {
  return createScanner({
    rulePacks: [fairuxBuiltinRulePack],
    includeExperimental: false,
    toolVersion: "corpus",
    now: () => new Date("1970-01-01T00:00:00.000Z"),
  });
}

function countByRule(findings) {
  const counts = new Map();
  for (const finding of findings) {
    counts.set(finding.ruleId, (counts.get(finding.ruleId) ?? 0) + 1);
  }
  return counts;
}

/**
 * Score one case.
 *
 * An expected rule that fired fewer times than labelled is a miss for the difference; one that fired
 * more is a false positive for the excess, because a duplicate finding is noise a user has to
 * dismiss. A tolerated rule is neither: the case is genuinely borderline and the label says so with
 * a reason, rather than forcing a judgement that would make the totals arbitrary.
 */
function scoreCase(entry, actualCounts) {
  const expected = new Map((entry.expected ?? []).map((item) => [item.ruleId, item.count]));
  const tolerated = new Set((entry.tolerated ?? []).map((item) => item.ruleId));

  const truePositives = [];
  const falsePositives = [];
  const falseNegatives = [];
  const toleratedSeen = [];

  for (const [ruleId, wanted] of expected) {
    const actual = actualCounts.get(ruleId) ?? 0;
    const matched = Math.min(actual, wanted);
    if (matched > 0) truePositives.push({ ruleId, count: matched });
    if (actual < wanted) falseNegatives.push({ ruleId, count: wanted - actual });
    if (actual > wanted) falsePositives.push({ ruleId, count: actual - wanted });
  }

  for (const [ruleId, actual] of actualCounts) {
    if (expected.has(ruleId)) continue;
    if (tolerated.has(ruleId)) {
      toleratedSeen.push({ ruleId, count: actual });
      continue;
    }
    falsePositives.push({ ruleId, count: actual });
  }

  const byRuleId = (left, right) => (left.ruleId < right.ruleId ? -1 : 1);
  return {
    id: entry.id,
    kind: entry.kind,
    locale: entry.locale,
    truePositives: truePositives.sort(byRuleId),
    falsePositives: falsePositives.sort(byRuleId),
    falseNegatives: falseNegatives.sort(byRuleId),
    tolerated: toleratedSeen.sort(byRuleId),
  };
}

function sumCounts(entries) {
  return entries.reduce((total, entry) => total + entry.count, 0);
}

function accumulate(target, ruleId, key, count) {
  const row = target.get(ruleId) ?? {
    ruleId,
    truePositives: 0,
    falsePositives: 0,
    falseNegatives: 0,
    tolerated: 0,
  };
  row[key] += count;
  target.set(ruleId, row);
}

/**
 * Rounded to three decimals so the artifact is stable, and absent rather than zero when the
 * denominator is: a rule with nothing to find has no recall, which is not the same as a recall of 0.
 */
function rate(numerator, denominator) {
  if (denominator === 0) return null;
  return Math.round((numerator / denominator) * 1000) / 1000;
}

/**
 * How much of the detection vocabulary these pages actually reach.
 *
 * Precision and recall are computed over the rules that fired. They say nothing about the patterns no
 * page here contains — and most of the dictionary is in that state, because a corpus written to
 * exercise rules exercises the phrasings whoever wrote it thought of.
 *
 * Reported rather than fixed. Writing a page per unmatched pattern would raise this number to 1 and
 * teach it to mean nothing: the pages would be derived from the patterns they test. It is a measure
 * of the corpus, not of the rules, and it is the sharpest statement of the limit this project keeps
 * restating in prose.
 */
function patternCoverage(pageTexts) {
  const byGroup = [];
  let matched = 0;
  let total = 0;
  for (const [locale, groups] of Object.entries(dictionary)) {
    for (const [group, patterns] of Object.entries(groups ?? {})) {
      const reached = patterns.filter((pattern) => pageTexts.some((text) => pattern.test(text)));
      byGroup.push({
        locale,
        group,
        patterns: patterns.length,
        reached: reached.length,
      });
      matched += reached.length;
      total += patterns.length;
    }
  }
  byGroup.sort((left, right) =>
    left.locale === right.locale
      ? left.group.localeCompare(right.group)
      : left.locale.localeCompare(right.locale),
  );
  return { patterns: total, reached: matched, rate: rate(matched, total), byGroup };
}

function evaluate() {
  const manifest = readJson(MANIFEST_PATH);
  const scanner = createCorpusScanner();
  const cases = [];
  const pageTexts = [];
  const byRule = new Map();

  // Every rule in the pack gets a row, including ones no case exercises. A rule missing from the
  // table would read as "nothing to report" where the truth is "never measured".
  for (const rule of fairuxBuiltinRulePack.rules) {
    if (rule.meta.experimental) continue;
    accumulate(byRule, rule.meta.id, "truePositives", 0);
  }

  for (const entry of manifest.cases) {
    const html = readFileSync(join(CORPUS_DIR, entry.file), "utf8");
    const document = parseHtml(html, { file: entry.file, dictionary });
    pageTexts.push(document.root.normalizedText);
    const report = scanner.scan(document);
    const scored = scoreCase(entry, countByRule(report.findings));
    cases.push(scored);
    for (const key of ["truePositives", "falsePositives", "falseNegatives", "tolerated"]) {
      for (const item of scored[key]) accumulate(byRule, item.ruleId, key, item.count);
    }
  }

  const totals = {
    cases: cases.length,
    truePositives: cases.reduce((n, c) => n + sumCounts(c.truePositives), 0),
    falsePositives: cases.reduce((n, c) => n + sumCounts(c.falsePositives), 0),
    falseNegatives: cases.reduce((n, c) => n + sumCounts(c.falseNegatives), 0),
    tolerated: cases.reduce((n, c) => n + sumCounts(c.tolerated), 0),
  };

  const rows = [...byRule.values()].sort((left, right) => (left.ruleId < right.ruleId ? -1 : 1));
  return {
    schemaVersion: 1,
    disclaimer: DISCLAIMER,
    ruleSet: {
      rulePack: fairuxBuiltinRulePack.meta.id,
      version: fairuxBuiltinRulePack.meta.version,
      includeExperimental: false,
    },
    totals: {
      ...totals,
      precision: rate(totals.truePositives, totals.truePositives + totals.falsePositives),
      recall: rate(totals.truePositives, totals.truePositives + totals.falseNegatives),
    },
    patternCoverage: patternCoverage(pageTexts),
    byRule: rows.map((row) => ({
      ...row,
      precision: rate(row.truePositives, row.truePositives + row.falsePositives),
      recall: rate(row.truePositives, row.truePositives + row.falseNegatives),
    })),
    cases,
  };
}

function renderMarkdown(result) {
  const lines = [
    "# Corpus evaluation",
    "",
    "<!-- Generated by scripts/evaluate-corpus.mjs. Do not edit by hand. -->",
    "",
    `> ${result.disclaimer}`,
    "",
    `Rule set: \`${result.ruleSet.rulePack}@${result.ruleSet.version}\`, experimental rules off.`,
    `Cases: ${result.totals.cases}. Method and boundaries: [corpus/README.md](../../corpus/README.md).`,
    "",
    "## Totals",
    "",
    "| Measure | Count |",
    "| --- | --- |",
    `| True positives | ${result.totals.truePositives} |`,
    `| False positives | ${result.totals.falsePositives} |`,
    `| False negatives | ${result.totals.falseNegatives} |`,
    `| Tolerated | ${result.totals.tolerated} |`,
    `| Precision on this corpus | ${formatRate(result.totals.precision)} |`,
    `| Recall on this corpus | ${formatRate(result.totals.recall)} |`,
    "",
    "## How much of the vocabulary these pages reach",
    "",
    `**${result.patternCoverage.reached} of ${result.patternCoverage.patterns} dictionary patterns ` +
      `(${formatRate(result.patternCoverage.rate)}) appear on at least one page here.** The precision ` +
      "and recall above are computed over the rules that fired; they say nothing about the phrasings " +
      "no page contains. A corpus written to exercise rules exercises the wordings whoever wrote it " +
      "thought of.",
    "",
    "This is reported, not fixed. Writing a page per unmatched pattern would raise it to 1.000 and " +
      "teach it to mean nothing, because the pages would be derived from the patterns they test. It " +
      "is a measure of the corpus, not of the rules.",
    "",
    "| Locale | Group | Reached | Patterns |",
    "| --- | --- | --- | --- |",
    ...result.patternCoverage.byGroup.map(
      (group) =>
        `| ${group.locale} | \`${group.group}\` | ${group.reached === 0 ? "**0**" : group.reached} | ${group.patterns} |`,
    ),
    "",
    "## By rule",
    "",
    "| Rule | TP | FP | FN | Tolerated | Precision | Recall |",
    "| --- | --- | --- | --- | --- | --- | --- |",
  ];

  for (const row of result.byRule) {
    lines.push(
      `| \`${row.ruleId}\` | ${row.truePositives} | ${row.falsePositives} | ${row.falseNegatives} | ${row.tolerated} | ${formatRate(row.precision)} | ${formatRate(row.recall)} |`,
    );
  }

  const imperfect = result.cases.filter(
    (entry) => entry.falsePositives.length > 0 || entry.falseNegatives.length > 0,
  );
  lines.push("", "## Cases that did not match their labels", "");
  if (imperfect.length === 0) {
    lines.push("None.");
  } else {
    lines.push("| Case | Unexpected | Missed |", "| --- | --- | --- |");
    for (const entry of imperfect) {
      lines.push(
        `| \`${entry.id}\` | ${formatItems(entry.falsePositives)} | ${formatItems(entry.falseNegatives)} |`,
      );
    }
  }

  return `${lines.join("\n")}\n`;
}

/** An unmeasured rate is a dash. Printing 0 would claim a measurement nobody made. */
function formatRate(value) {
  return value === null ? "—" : value.toFixed(3);
}

function formatItems(items) {
  return items.length === 0
    ? "—"
    : items
        .map((item) => `\`${item.ruleId}\`${item.count > 1 ? ` ×${item.count}` : ""}`)
        .join(", ");
}

function main() {
  const mode = process.argv.includes("--check") ? "check" : "write";
  const result = evaluate();
  const json = `${JSON.stringify(result, null, 2)}\n`;
  const markdown = renderMarkdown(result);

  if (mode === "write") {
    writeFileSync(JSON_ARTIFACT, json, "utf8");
    writeFileSync(MARKDOWN_ARTIFACT, markdown, "utf8");
    process.stdout.write(
      `corpus: ${result.totals.cases} cases, ${result.totals.truePositives} true positives, ` +
        `${result.totals.falsePositives} false positives, ${result.totals.falseNegatives} misses\n`,
    );
    return;
  }

  const failures = [];
  if (readFileSync(JSON_ARTIFACT, "utf8") !== json) failures.push(JSON_ARTIFACT);
  if (readFileSync(MARKDOWN_ARTIFACT, "utf8") !== markdown) failures.push(MARKDOWN_ARTIFACT);
  if (failures.length > 0) {
    process.stderr.write(
      `corpus evaluation is out of date:\n${failures.map((path) => `  - ${path}`).join("\n")}\n` +
        "Run `pnpm eval:corpus` and review the diff — a change here is a change in detection quality.\n",
    );
    process.exitCode = 1;
    return;
  }
  process.stdout.write(
    `corpus evaluation matches the committed artifacts (${result.totals.cases} cases)\n`,
  );
}

// Only when run as a script. Importing this module — the scoring test does — must not rewrite the
// committed artifacts as a side effect: a test that regenerated what it is checking would pass
// against anything.
const thisFilePath = fileURLToPath(import.meta.url);
if (process.argv[1] === thisFilePath) main();

export { evaluate, scoreCase };
