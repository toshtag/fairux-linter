#!/usr/bin/env node
/**
 * Calibrate `fairux-risk/1` against the labelled corpus, and measure how much the calibration
 * depends on the weights it was calibrated with.
 *
 * The claim under test is **separation**: every corpus page labelled as having a problem scores above
 * every page labelled clean. It is a claim that can fail, which is the only kind worth checking in.
 *
 * The sensitivity analysis perturbs the model's parameters and re-runs the same formula through the
 * same factory. Measuring a second copy of the arithmetic would measure the copy, and the two would
 * drift apart exactly when it mattered.
 */

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { computeRiskIndex, createScanner } from "../packages/core/dist/index.js";
import { parseHtml } from "../packages/html/dist/index.js";
import {
  createRiskIndexModel,
  DEFAULT_RISK_MODEL_PARAMETERS,
  fairuxBuiltinRulePack,
  fairuxRiskIndexModel,
  MAX_SCORE,
  WORST_INPUT,
} from "../packages/rules/dist/index.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CORPUS_DIR = join(ROOT, "corpus");
const JSON_ARTIFACT = join(ROOT, "docs/generated/risk-index-calibration.json");
const MARKDOWN_ARTIFACT = join(ROOT, "docs/generated/risk-index-calibration.md");

const DISCLAIMER =
  "Calibrated against 26 pages this project wrote. Separation on them is not evidence about pages nobody here has seen.";

function scanner() {
  return createScanner({
    rulePacks: [fairuxBuiltinRulePack],
    includeExperimental: false,
    toolVersion: "calibration",
    now: () => new Date("1970-01-01T00:00:00.000Z"),
  });
}

function scoreCases(model) {
  const manifest = JSON.parse(readFileSync(join(CORPUS_DIR, "manifest.json"), "utf8"));
  const scan = scanner();
  return manifest.cases.map((entry) => {
    const html = readFileSync(join(CORPUS_DIR, entry.file), "utf8");
    const report = scan.scan(parseHtml(html, { file: entry.file }));
    const index = computeRiskIndex(report, {
      model,
      toolVersion: "calibration",
      now: () => new Date("1970-01-01T00:00:00.000Z"),
    });
    return {
      id: entry.id,
      kind: entry.kind,
      locale: entry.locale,
      status: index.status,
      score: index.score,
      confidence: index.confidence,
      // Kept because it separates the two failures a zero score can mean: nothing was wrong, or
      // nothing was found. Only one of them is a scoring problem.
      findingCount: report.findings.length,
    };
  });
}

/**
 * Separation, stated so it can fail — and scoped to what a score can possibly be about.
 *
 * A page whose problem the rules never detected scores zero, and no arrangement of weights can rank
 * it above a clean page: there is nothing to weigh. That is a recall failure, already counted by the
 * [corpus evaluation](../docs/generated/corpus-evaluation.md), and folding it in here would report a
 * detection gap as a scoring gap and hide both.
 *
 * So the claim is: **among the problem pages the rules actually detected, every one scores above
 * every clean page**. The pages that were missed are listed beside it rather than averaged away,
 * because a reader needs to know the index is silent about them.
 *
 * `margin` is the gap. Zero or negative means the model ranks a clean page at or above a detected
 * bad one, which should stop a release rather than be rounded away.
 */
function separationOf(cases) {
  const positives = cases.filter((entry) => entry.kind === "positive" && entry.score !== null);
  const detected = positives.filter((entry) => entry.findingCount > 0);
  const undetected = positives.filter((entry) => entry.findingCount === 0);
  const negatives = cases.filter((entry) => entry.kind === "negative" && entry.score !== null);
  const minDetected = Math.min(...detected.map((entry) => entry.score));
  const maxNegative =
    negatives.length === 0 ? 0 : Math.max(...negatives.map((entry) => entry.score));
  return {
    problemPages: positives.length,
    detectedProblemPages: detected.length,
    undetectedProblemPages: undetected.map((entry) => entry.id),
    cleanPages: negatives.length,
    minDetectedScore: Number.isFinite(minDetected) ? minDetected : null,
    maxCleanScore: maxNegative,
    margin: Number.isFinite(minDetected) ? minDetected - maxNegative : null,
    separated: Number.isFinite(minDetected) && minDetected > maxNegative,
  };
}

/**
 * Does the separation survive different weights?
 *
 * If it only holds at exactly the shipped constants, they were fitted to 26 pages rather than argued
 * for, and that is worth knowing before the number ships. Each variant changes one thing.
 */
function sensitivity() {
  const base = DEFAULT_RISK_MODEL_PARAMETERS;
  const variants = [
    [
      "flat severity (all 10)",
      { ...base, severityWeights: { high: 10, medium: 10, low: 10, info: 10 } },
    ],
    [
      "gentle severity (linear)",
      { ...base, severityWeights: { high: 8, medium: 6, low: 4, info: 2 } },
    ],
    [
      "steep severity (×4 steps)",
      { ...base, severityWeights: { high: 80, medium: 20, low: 5, info: 2 } },
    ],
    ["confidence ignored", { ...base, confidenceFactors: { high: 1, medium: 1, low: 1 } }],
    ["low confidence dropped", { ...base, confidenceFactors: { high: 1, medium: 0.6, low: 0 } }],
    ["confidence dominant", { ...base, confidenceFactors: { high: 1, medium: 0.2, low: 0.05 } }],
  ];

  return variants.map(([label, parameters]) => {
    const model = createRiskIndexModel({ ...parameters, version: `sensitivity/${label}` });
    return { variant: label, separation: separationOf(scoreCases(model)) };
  });
}

/**
 * Candidate aggregations, measured and **not adopted**.
 *
 * `fairux-risk/1` scores the worst single input, which cannot see breadth: one bad page and ten
 * identical bad pages produce the same number. That is stated in the model's limitations; the
 * collections below turn it into something a reader can check, and put the obvious alternatives
 * beside it with their failure modes visible rather than argued about.
 *
 * Each runs through the real factory with only the combination step swapped, so a difference between
 * two rows is the aggregation and nothing else. Adopting any of them is a new `modelVersion` with its
 * own argument — see docs/risk-index-model.md#changing-it.
 */
const AGGREGATION_CANDIDATES = [
  {
    id: "worst-input",
    label: "worst input (shipped)",
    note: "What `fairux-risk/1` does. Blind to breadth by construction.",
    aggregate: WORST_INPUT,
  },
  {
    id: "worst-plus-affected-share",
    label: "worst + share of inputs affected",
    note: "Punishes coverage: adding a clean page lowers the score, so scanning less looks better.",
    aggregate: (totals) => {
      const worst = WORST_INPUT(totals);
      const affected = totals.filter((total) => total > 0).length;
      const share = totals.length === 0 ? 0 : affected / totals.length;
      return worst + (MAX_SCORE - worst) * share * 0.5;
    },
  },
  {
    id: "worst-plus-affected-count",
    label: "worst + count of inputs affected",
    note: "Sees breadth without reading the denominator, so a clean page cannot lower it. Introduces no constant, and climbs fast.",
    aggregate: (totals) => {
      const worst = WORST_INPUT(totals);
      const affected = totals.filter((total) => total > 0).length;
      return affected <= 1 ? worst : worst + (MAX_SCORE - worst) * (1 - 1 / affected);
    },
  },
  {
    id: "p90",
    label: "90th percentile input",
    note: "More robust to one anomalous page, and less honest about it: the severe page disappears among mild ones.",
    aggregate: (totals) => {
      if (totals.length === 0) return 0;
      const sorted = [...totals].sort((left, right) => left - right);
      const rank = Math.ceil(0.9 * sorted.length) - 1;
      return sorted[Math.max(0, rank)];
    },
  },
  {
    id: "sum",
    label: "sum of inputs",
    note: "The size effect the worst-input rule was chosen to avoid: a large site scores worse for having more pages.",
    aggregate: (totals) => totals.reduce((sum, total) => sum + total, 0),
  },
];

/**
 * Score every collection under every candidate.
 *
 * Collections are scanned as **journeys**, which is the multi-input report this engine builds
 * natively. The model groups a batch's inputs and a journey's steps through the same path, so the
 * aggregation sees the same list of per-input totals either way — and building a batch report here
 * would mean a second copy of a shape the CLI already owns.
 */
function scoreCollections() {
  const manifest = JSON.parse(readFileSync(join(CORPUS_DIR, "manifest.json"), "utf8"));
  const byId = new Map(manifest.cases.map((entry) => [entry.id, entry]));
  const scan = scanner();

  return (manifest.collections ?? []).map((collection) => {
    const steps = collection.caseIds.map((caseId, index) => {
      const entry = byId.get(caseId);
      if (!entry) throw new Error(`collection ${collection.id} names unknown case ${caseId}`);
      const html = readFileSync(join(CORPUS_DIR, entry.file), "utf8");
      return {
        // Repeating a case is the point of one collection, so the step id carries the position.
        id: `${caseId}#${index}`,
        order: index + 1,
        document: parseHtml(html, { file: entry.file }),
      };
    });
    const report = scan.scanJourney({ steps });

    const scores = {};
    for (const candidate of AGGREGATION_CANDIDATES) {
      const model = createRiskIndexModel({
        ...DEFAULT_RISK_MODEL_PARAMETERS,
        version: `candidate/${candidate.id}`,
        aggregate: candidate.aggregate,
      });
      const index = computeRiskIndex(report, {
        model,
        toolVersion: "calibration",
        now: () => new Date("1970-01-01T00:00:00.000Z"),
      });
      scores[candidate.id] = index.score;
    }

    return {
      id: collection.id,
      kind: collection.kind,
      inputs: steps.length,
      inputsWithFindings: report.steps.filter((step) => step.report.findings.length > 0).length,
      // The journey's own layer, which is empty until a journey rule exists. Recorded rather than
      // assumed: it is the fact #135's questions rest on.
      crossStepFindings: report.findings.length,
      scores,
    };
  });
}

/**
 * The two properties a candidate has to have, checked rather than described.
 *
 * `seesBreadth` — the same problem on five pages scores above the same problem on one.
 * `punishesCoverage` — a problem page scanned beside nine clean ones scores **below** the same
 * problem page scanned alone, which would make scanning less the way to a better number.
 */
function aggregationVerdicts(collections) {
  const scoreOf = (id, candidate) =>
    collections.find((entry) => entry.id === id)?.scores[candidate] ?? null;
  return AGGREGATION_CANDIDATES.map((candidate) => {
    const alone = scoreOf("breadth-one-problem-page", candidate.id);
    const repeated = scoreOf("breadth-problem-page-repeated", candidate.id);
    const amongClean = scoreOf("breadth-problem-page-among-clean", candidate.id);
    return {
      id: candidate.id,
      label: candidate.label,
      note: candidate.note,
      seesBreadth: repeated !== null && alone !== null && repeated > alone,
      punishesCoverage: amongClean !== null && alone !== null && amongClean < alone,
    };
  });
}

function build() {
  const cases = scoreCases(fairuxRiskIndexModel);
  const collections = scoreCollections();
  const separation = separationOf(cases);
  const variants = sensitivity();
  return {
    schemaVersion: 1,
    disclaimer: DISCLAIMER,
    modelVersion: fairuxRiskIndexModel.version,
    parameters: {
      severityWeights: DEFAULT_RISK_MODEL_PARAMETERS.severityWeights,
      confidenceFactors: DEFAULT_RISK_MODEL_PARAMETERS.confidenceFactors,
    },
    separation,
    sensitivity: variants,
    aggregation: {
      shipped: "worst-input",
      candidates: aggregationVerdicts(collections),
      collections,
    },
    cases,
  };
}

function renderMarkdown(result) {
  const lines = [
    "# Risk Index calibration",
    "",
    "<!-- Generated by scripts/calibrate-risk-index.mjs. Do not edit by hand. -->",
    "",
    `> ${result.disclaimer}`,
    "",
    `Model: \`${result.modelVersion}\`. Reasoning for every constant: [risk index model](../risk-index-model.md).`,
    "",
    "## Separation",
    "",
    "The claim: among the problem pages the rules **detected**, every one scores above every clean",
    "page. A page whose problem was never found scores zero, and no arrangement of weights can rank",
    "it above a clean page — there is nothing to weigh. That is a recall failure, counted by the",
    "[corpus evaluation](corpus-evaluation.md), and folding it in here would report a detection gap",
    "as a scoring gap and hide both.",
    "",
    "| Measure | Value |",
    "| --- | --- |",
    `| Pages with a labelled problem | ${result.separation.problemPages} |`,
    `| …of those, detected by the rules | ${result.separation.detectedProblemPages} |`,
    `| Pages labelled clean | ${result.separation.cleanPages} |`,
    `| Lowest score among detected problem pages | ${result.separation.minDetectedScore} |`,
    `| Highest score among clean pages | ${result.separation.maxCleanScore} |`,
    `| Margin | ${result.separation.margin} |`,
    `| Separated | ${result.separation.separated ? "yes" : "**no**"} |`,
    "",
    "### Pages the index is silent about",
    "",
    result.separation.undetectedProblemPages.length === 0
      ? "None."
      : `${result.separation.undetectedProblemPages
          .map((id) => `\`${id}\``)
          .join(
            ", ",
          )} — labelled as having a problem, detected by nothing, and therefore scored 0. The index cannot rank a page whose problem was never found.`,
    "",
    "## Sensitivity",
    "",
    "Whether the separation survives different weights. If it held only at the shipped constants,",
    "they would be fitted to 26 pages rather than argued for.",
    "",
    "| Variant | Margin | Separated |",
    "| --- | --- | --- |",
  ];
  for (const variant of result.sensitivity) {
    lines.push(
      `| ${variant.variant} | ${variant.separation.margin} | ${variant.separation.separated ? "yes" : "**no**"} |`,
    );
  }

  lines.push(
    "",
    "## Aggregation",
    "",
    "`fairux-risk/1` scores the **worst single input**, so one bad page and ten identical bad pages",
    "produce the same number. The collections in `corpus/manifest.json` make that measurable, and put",
    "the obvious alternatives beside it. **None of these is adopted** — a different aggregation is a",
    "different `modelVersion`, with its own argument.",
    "",
    "Two properties decide whether a candidate is worth considering at all:",
    "",
    "- **Sees breadth** — the same problem on five pages scores above the same problem on one.",
    "- **Punishes coverage** — a problem page scanned beside nine clean ones scores *below* the same",
    "  page scanned alone, which would make scanning less the way to a better number. This one is a",
    "  disqualifier.",
    "",
    "| Candidate | Sees breadth | Punishes coverage | What it does |",
    "| --- | --- | --- | --- |",
  );
  for (const candidate of result.aggregation.candidates) {
    lines.push(
      `| ${candidate.label} | ${candidate.seesBreadth ? "yes" : "no"} | ` +
        `${candidate.punishesCoverage ? "**yes**" : "no"} | ${candidate.note} |`,
    );
  }

  const candidateLabels = result.aggregation.candidates.map((candidate) => candidate.label);
  lines.push(
    "",
    "### Every collection, under every candidate",
    "",
    "`inputs` counts everything scanned; `affected` counts the ones that produced a finding. An",
    "input with nothing on it contributes a zero rather than being absent, which is what lets a",
    "candidate have a denominator at all.",
    "",
    `| Collection | Inputs | Affected | Cross-step | ${candidateLabels.join(" | ")} |`,
    `| --- | --- | --- | --- | ${candidateLabels.map(() => "---").join(" | ")} |`,
  );
  for (const collection of result.aggregation.collections) {
    const scores = result.aggregation.candidates.map(
      (candidate) => collection.scores[candidate.id] ?? "—",
    );
    lines.push(
      `| \`${collection.id}\` | ${collection.inputs} | ${collection.inputsWithFindings} | ` +
        `${collection.crossStepFindings} | ${scores.join(" | ")} |`,
    );
  }

  lines.push(
    "",
    "### Journeys",
    "",
    "Every journey above reports **zero cross-step findings**, because the built-in rule set contains",
    "no journey rule. So a journey's score today comes entirely from its steps, and the questions",
    "about how a cross-step finding should weigh are not answerable by measurement yet — which is",
    "what [issue #135](https://github.com/toshtag/fairux-linter/issues/135) says, and this confirms it",
    "rather than assuming it.",
    "",
    "What is already visible: a flow broken at every step scores barely above one broken only at the",
    "end. The journey layer inherits the worst-input aggregation and its blindness to breadth exactly",
    "as a set of pages does.",
    "",
    "## Every case",
    "",
    "| Case | Label | Score | Confidence |",
    "| --- | --- | --- | --- |",
  );
  for (const entry of result.cases) {
    lines.push(
      `| \`${entry.id}\` | ${entry.kind} | ${entry.score ?? "—"} | ${entry.confidence ?? "—"} |`,
    );
  }

  return `${lines.join("\n")}\n`;
}

/**
 * Formatted by Biome, the way the rule catalog is.
 *
 * `JSON.stringify` and the repository's formatter disagree about short arrays, and an artifact that
 * fails `pnpm lint` the moment it is generated would train everyone to regenerate and then hand-edit.
 */
function formatted(contents, path) {
  const result = spawnSync("pnpm", ["exec", "biome", "format", "--stdin-file-path", path], {
    cwd: ROOT,
    input: contents,
    encoding: "utf8",
  });
  if (result.status !== 0)
    throw new Error(result.stderr || `Biome failed while formatting ${path}`);
  return result.stdout;
}

function main() {
  const mode = process.argv.includes("--check") ? "check" : "write";
  const result = build();
  const json = formatted(`${JSON.stringify(result, null, 2)}\n`, JSON_ARTIFACT);
  const markdown = renderMarkdown(result);

  if (mode === "write") {
    writeFileSync(JSON_ARTIFACT, json, "utf8");
    writeFileSync(MARKDOWN_ARTIFACT, markdown, "utf8");
    process.stdout.write(
      `risk index: margin ${result.separation.margin}, separated ${result.separation.separated}\n`,
    );
    return;
  }

  const stale = [];
  if (readFileSync(JSON_ARTIFACT, "utf8") !== json) stale.push(JSON_ARTIFACT);
  if (readFileSync(MARKDOWN_ARTIFACT, "utf8") !== markdown) stale.push(MARKDOWN_ARTIFACT);
  if (stale.length > 0) {
    process.stderr.write(
      `risk index calibration is out of date:\n${stale.map((path) => `  - ${path}`).join("\n")}\n` +
        "Run `pnpm calibrate:risk-index` and read the diff — a change here is a change in what the score means.\n",
    );
    process.exitCode = 1;
    return;
  }
  if (!result.separation.separated) {
    // Checked here as well as in the tests: a committed artifact recording a failed separation would
    // otherwise pass a freshness check and ship a number that ranks a clean page above a bad one.
    process.stderr.write(
      "risk index calibration does not separate labelled problems from clean pages\n",
    );
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`risk index calibration matches (margin ${result.separation.margin})\n`);
}

const thisFilePath = fileURLToPath(import.meta.url);
if (process.argv[1] === thisFilePath) main();

export { build, separationOf };
