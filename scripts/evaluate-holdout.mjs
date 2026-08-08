#!/usr/bin/env node
/**
 * Score the built-in rule set against an external holdout package.
 *
 * The corpus measures quality on pages this project wrote. `P7` asks for quality on pages it did
 * not, and [the release criteria](../docs/maintainers/release-criteria.md) name four conditions so
 * that a smaller thing cannot close it. `scripts/holdout-contract.mjs` is those conditions; this is
 * the half that opens files.
 *
 *     node scripts/evaluate-holdout.mjs --package ../fairux-holdout-2026a
 *     node scripts/evaluate-holdout.mjs --package ../fairux-holdout-2026a --json ./holdout-run.json
 *     node scripts/evaluate-holdout.mjs --package ../fairux-holdout-2026a --seal
 *
 * **This never writes into the package.** Not in `--seal` either, which prints the digest for the
 * preparer to paste in rather than editing their manifest. A tool that can write into a holdout is
 * a tool that can quietly re-seal one after a disappointing result, and no amount of care in the
 * runbook makes that as easy to trust as not having the capability.
 *
 * It does not read `corpus/` at all, which is the other half of the same separation: the holdout is
 * evidence, the corpus is what the rules were tuned against, and a sample that leaked from one into
 * the other would destroy the only thing the holdout has.
 *
 * The package lives outside this repository. Nothing here requires it to be committed, and the
 * runbook — `docs/maintainers/holdout-evaluation.md` — says why it must not be.
 */

import { lstatSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseSource } from "../packages/ast/dist/index.js";
import { createScanner } from "../packages/core/dist/index.js";
import { parseFigma } from "../packages/figma/dist/index.js";
import { parseHtml } from "../packages/html/dist/index.js";
import { dictionary, fairuxBuiltinRulePack } from "../packages/rules/dist/index.js";
import { scoreCase } from "./evaluate-corpus.mjs";
import {
  coverageRefusals,
  EVIDENCE_CLASSES,
  manifestRefusals,
  minimumSamples,
  requiredStrata,
  sealDigest,
  summarise,
} from "./holdout-contract.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MANIFEST_NAME = "holdout.json";

/** The rules a default scan runs. Experimental rules are off, so measuring them would score nothing anyone runs. */
function stableRuleIds() {
  return fairuxBuiltinRulePack.rules
    .filter((rule) => !rule.meta.experimental)
    .map((rule) => rule.meta.id)
    .sort();
}

function vocabulary() {
  return { locales: Object.keys(dictionary).sort(), ruleIds: stableRuleIds() };
}

/**
 * `--package <dir>`, `--json <file>`, `--seal`. Anything else is a mistake worth naming.
 *
 * The bare `--` is dropped the way `apps/cli/scripts/release-check.mjs` drops it: `pnpm run` passes
 * the separator through, so a script that refused it would refuse its own documented invocation.
 */
function parseArguments(rawArgv) {
  const argv = rawArgv.filter((argument) => argument !== "--");
  const options = { seal: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--seal") options.seal = true;
    else if (argument === "--package" || argument === "--json") {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new Error(`${argument} needs a path`);
      }
      options[argument === "--package" ? "packageDir" : "json"] = value;
      index += 1;
    } else throw new Error(`unknown argument ${JSON.stringify(argument)}`);
  }
  if (!options.packageDir) throw new Error("--package <dir> is required");
  return options;
}

/** The adapter a sample's declared runtime names. */
function parseSample(runtime, source, file) {
  if (runtime === "figma") return parseFigma(source, { file });
  if (runtime === "ast") return parseSource(source, { file });
  return parseHtml(source, { file, dictionary });
}

function countByRule(findings) {
  const counts = new Map();
  for (const finding of findings) {
    counts.set(finding.ruleId, (counts.get(finding.ruleId) ?? 0) + 1);
  }
  return counts;
}

/**
 * What the filesystem says about a sample path, before a byte of it is read.
 *
 * `manifestRefusals` answers the *lexical* question — is this a relative path with no `..` in it —
 * and a symlink answers it perfectly while pointing anywhere at all:
 *
 *     ln -s /etc/passwd pages/consent-banner-en.html
 *     { "file": "pages/consent-banner-en.html" }     // clean by every string test
 *
 * The package is prepared by somebody outside this repository and a maintainer runs this against
 * their own filesystem, so that read is the boundary. Every symlink is refused rather than resolved
 * and compared: a holdout is a set of files, none of it needs a link, and "does this resolved path
 * still live inside the package" is a question with edge cases where "is any part of this a link"
 * has none.
 *
 * Every segment, not only the last — `pages` being a link to `/etc` reads exactly as far.
 */
function containmentRefusal(packageDir, file) {
  let current = packageDir;
  for (const segment of file.split(/[/\\]/)) {
    if (segment === "") continue;
    current = join(current, segment);
    let entry;
    try {
      entry = lstatSync(current);
    } catch {
      return `${file} is not in the package`;
    }
    if (entry.isSymbolicLink()) {
      return `${file} passes through a symlink at "${segment}" — a holdout is files, and a link can name anything`;
    }
  }
  if (!lstatSync(current).isFile()) return `${file} is not a regular file`;
  return undefined;
}

/** Every sample whose path the filesystem refuses, before any of them is opened. */
export function containmentRefusals(packageDir, manifest) {
  return manifest.samples
    .map((sample) => {
      const refusal = containmentRefusal(packageDir, sample.file);
      return refusal ? `${sample.id}: ${refusal}` : undefined;
    })
    .filter((entry) => entry !== undefined);
}

/**
 * Read every sample's bytes once, keyed by sample id.
 *
 * Once, because the digest and the scan must be looking at the same bytes: reading twice leaves a
 * window in which a package could be sealed against one file and scored against another.
 */
function readSamples(packageDir, manifest) {
  const contents = new Map();
  for (const sample of manifest.samples) {
    contents.set(sample.id, readFileSync(join(packageDir, sample.file), "utf8"));
  }
  return contents;
}

/**
 * Everything this run refuses to score, and why.
 *
 * Ordered so the answer is the most actionable one: a malformed manifest before a broken seal, a
 * broken seal before missing coverage, and nothing scanned until all three pass. Scoring a package
 * that cannot bear a claim is how the claim gets made anyway.
 *
 * The **reads happen inside this function**, after the manifest has been judged and not before. The
 * manifest is written by somebody outside this repository and names files this process opens, so
 * "refuse before you read" has to be a property of the code rather than of the caller's ordering —
 * it was the caller's ordering once, and a sample naming `../../../etc/passwd` was opened before
 * anything looked at it.
 *
 * Two questions, in two stages, because they are answered by different things. The manifest stage
 * asks what the *string* says; the containment stage asks what the *filesystem* says, and a symlink
 * is where those two disagree.
 *
 * @param {() => string[]} inspect  what the filesystem refuses, without opening anything
 * @param {() => Map<string, string>} readContents  every sample's bytes, read once, on demand
 */
export function refusalsFor({ manifest, vocabulary: vocab, inspect, readContents }) {
  const shape = manifestRefusals(manifest, vocab);
  if (shape.length > 0) return { stage: "manifest", refusals: shape };

  const containment = inspect();
  if (containment.length > 0) return { stage: "containment", refusals: containment };

  const contents = readContents();
  const digest = sealDigest(manifest, contents);
  if (digest !== manifest.seal.digest) {
    return {
      stage: "seal",
      contents,
      refusals: [
        `the package does not match its seal — recorded ${manifest.seal.digest.slice(0, 12)}…, read ${digest.slice(0, 12)}…`,
        "a page, a label, or the rule-pack version moved after the package was sealed. A holdout " +
          "edited after it was evaluated is a corpus; re-seal it only if it has never been scored.",
      ],
    };
  }

  const coverage = coverageRefusals(manifest, vocab);
  if (coverage.length > 0) return { stage: "coverage", contents, refusals: coverage };
  return { stage: null, contents, refusals: [] };
}

function evaluate(packageDir, manifest, contents) {
  const scanner = createScanner({
    rulePacks: [fairuxBuiltinRulePack],
    includeExperimental: false,
    toolVersion: "holdout",
    now: () => new Date("1970-01-01T00:00:00.000Z"),
  });

  const scored = manifest.samples.map((sample) => {
    const document = parseSample(sample.runtime, contents.get(sample.id), sample.file);
    const report = scanner.scan(document);
    // The corpus's own scoring function, so a holdout number and a corpus number are the same
    // measurement over different pages. A second implementation would make the comparison the two
    // exist for meaningless.
    const result = scoreCase(sample, countByRule(report.findings));
    return {
      ...result,
      locale: sample.locale,
      runtime: sample.runtime,
      expected: sample.expected ?? [],
      negativeFor: sample.negativeFor ?? [],
    };
  });

  const summary = summarise(scored, stableRuleIds(), requiredStrata(vocabulary().locales));
  return {
    schemaVersion: 1,
    evidenceClass: manifest.evidenceClass,
    // The whole point of the field, stated as a value a reader's tooling can branch on rather than
    // as a sentence somebody has to notice.
    p7Eligible: manifest.evidenceClass === EVIDENCE_CLASSES.EXTERNAL,
    package: {
      id: manifest.packageId,
      preparedBy: manifest.preparedBy,
      preparedAt: manifest.preparedAt,
      seal: manifest.seal,
      directory: relative(ROOT, packageDir) || packageDir,
    },
    ruleSet: {
      rulePack: fairuxBuiltinRulePack.meta.id,
      version: fairuxBuiltinRulePack.meta.version,
      includeExperimental: false,
    },
    minimumSamples: minimumSamples(),
    ...summary,
    samples: scored.map((sample) => ({
      id: sample.id,
      locale: sample.locale,
      runtime: sample.runtime,
      truePositives: sample.truePositives,
      falsePositives: sample.falsePositives,
      falseNegatives: sample.falseNegatives,
    })),
  };
}

function formatInterval(interval) {
  if (!interval) return "— (nothing to measure)";
  return `${interval.point.toFixed(3)} [${interval.lower.toFixed(3)}–${interval.upper.toFixed(3)}], n=${interval.trials}`;
}

function renderMarkdown(result) {
  const banner = result.p7Eligible
    ? "External holdout. These numbers are about pages nobody here wrote."
    : "**Harness fixture — not evidence about detection quality.** This package was written to test " +
      "the evaluator, by the same people who wrote the rules. It cannot bear on P7.";

  const lines = [
    "# Holdout evaluation",
    "",
    `> ${banner}`,
    "",
    `Package: \`${result.package.id}\`, sealed \`${result.package.seal.digest.slice(0, 16)}…\`, prepared by ${result.package.preparedBy} on ${result.package.preparedAt}.`,
    `Rule set: \`${result.ruleSet.rulePack}@${result.ruleSet.version}\`, experimental rules off.`,
    `Samples: ${result.totals.samples}. Minimum behind any reported rate: ${result.minimumSamples} — ` +
      "per rule in each direction, and per stratum.",
    "",
    "Every rate is a Wilson 95% interval with the count it rests on. Precision and recall are over",
    "finding occurrences, as the corpus evaluation reports them, so the two are comparable.",
    "Specificity is over declared near misses only — pages built to look like ones a rule should fire",
    "on — because that is the denominator that answers how often a rule is wrong where it matters.",
    "",
    "## Totals",
    "",
    "| Measure | Value |",
    "| --- | --- |",
    `| True positives | ${result.totals.truePositives} |`,
    `| False positives | ${result.totals.falsePositives} |`,
    `| False negatives | ${result.totals.falseNegatives} |`,
    `| True negatives | ${result.totals.trueNegatives} |`,
    `| Precision | ${formatInterval(result.totals.precision)} |`,
    `| Recall | ${formatInterval(result.totals.recall)} |`,
    `| Specificity on near misses | ${formatInterval(result.totals.specificity)} |`,
    "",
    "## By rule",
    "",
    "| Rule | TP | FP | FN | TN | Precision | Recall | Specificity |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
    ...result.byRule.map(
      (row) =>
        `| \`${row.ruleId}\` | ${row.truePositives} | ${row.falsePositives} | ${row.falseNegatives} | ${row.trueNegatives} | ${formatInterval(row.precision)} | ${formatInterval(row.recall)} | ${formatInterval(row.specificity)} |`,
    ),
    "",
    "## By stratum",
    "",
    "Reported per stratum rather than pooled: a pooled score hides a locale or an adapter that is",
    "entirely wrong.",
    "",
    `Every stratum needs at least ${result.minimumSamples} samples of its own. One that is short is`,
    "marked, and its rates are printed for completeness rather than because they mean anything.",
    "",
    "| Locale | Runtime | Samples | TP | FP | FN | Precision | Recall |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
    ...result.byStratum.map(
      (row) =>
        `| ${row.locale} | ${row.runtime} | ${row.samples}${row.belowMinimum ? ` **(short by ${result.minimumSamples - row.samples})**` : ""} | ${row.truePositives} | ${row.falsePositives} | ${row.falseNegatives} | ${formatInterval(row.precision)} | ${formatInterval(row.recall)} |`,
    ),
    "",
  ];
  return `${lines.join("\n")}\n`;
}

function main() {
  let options;
  try {
    options = parseArguments(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`holdout: ${error.message}\n`);
    process.exitCode = 2;
    return;
  }

  const packageDir = resolve(options.packageDir);
  const manifest = JSON.parse(readFileSync(join(packageDir, MANIFEST_NAME), "utf8"));
  const vocab = vocabulary();

  if (options.seal) {
    // Preparation, not evaluation. The shape is checked so a preparer is not handed a digest over a
    // manifest that will be refused anyway; the seal itself is not, because it is what this prints.
    const shape = manifestRefusals(
      { ...manifest, seal: { algorithm: "sha256", digest: "0".repeat(64) } },
      vocab,
    );
    if (shape.length > 0) {
      process.stderr.write(`holdout: the manifest is not ready to seal:\n${bullets(shape)}`);
      process.exitCode = 1;
      return;
    }
    const containment = containmentRefusals(packageDir, manifest);
    if (containment.length > 0) {
      // The same boundary as an evaluation. Sealing reads every byte too, and a preparer handed a
      // digest over a link would have sealed something that is not in their package.
      process.stderr.write(`holdout: the package is not ready to seal:\n${bullets(containment)}`);
      process.exitCode = 1;
      return;
    }
    const digest = sealDigest(manifest, readSamples(packageDir, manifest));
    process.stdout.write(`${digest}\n`);
    process.stderr.write(
      'holdout: paste this into the manifest as {"algorithm":"sha256","digest":"…"}. ' +
        "Nothing here wrote to your package.\n",
    );
    return;
  }

  const { stage, refusals, contents } = refusalsFor({
    manifest,
    vocabulary: vocab,
    inspect: () => containmentRefusals(packageDir, manifest),
    readContents: () => readSamples(packageDir, manifest),
  });
  if (stage) {
    process.stderr.write(`holdout: refused at the ${stage} stage:\n${bullets(refusals)}`);
    process.exitCode = 1;
    return;
  }

  const result = evaluate(packageDir, manifest, contents);
  process.stdout.write(renderMarkdown(result));

  if (options.json) {
    const target = resolve(options.json);
    const inside = relative(packageDir, target);
    if (inside !== "" && !inside.startsWith("..") && !isAbsolute(inside)) {
      process.stderr.write(
        "holdout: --json names a path inside the package, and nothing may write there. " +
          "Write the run somewhere else.\n",
      );
      process.exitCode = 1;
      return;
    }
    writeFileSync(target, `${JSON.stringify(result, null, 2)}\n`, "utf8");
    process.stderr.write(`holdout: wrote ${target}\n`);
  }

  if (!result.p7Eligible) {
    process.stderr.write(
      "holdout: this package is a harness fixture. It tests the evaluator and is not evidence " +
        "about detection quality — P7 stays open.\n",
    );
  }
}

function bullets(lines) {
  return `${lines.map((line) => `  - ${line}`).join("\n")}\n`;
}

const thisFilePath = fileURLToPath(import.meta.url);
if (process.argv[1] === thisFilePath) main();

export { evaluate, readSamples, renderMarkdown };
