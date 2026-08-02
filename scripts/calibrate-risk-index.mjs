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
  fairuxRiskIndexModelV2,
  MAX_SCORE,
  RISK_MODEL_V2_PARAMETERS,
  WORST_INPUT,
  WORST_WITH_BREADTH,
} from "../packages/rules/dist/index.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CORPUS_DIR = join(ROOT, "corpus");
const JSON_ARTIFACT = join(ROOT, "docs/generated/risk-index-calibration.json");
const MARKDOWN_ARTIFACT = join(ROOT, "docs/generated/risk-index-calibration.md");

/**
 * Derived, not written down.
 *
 * It said "26 pages" for long enough that the corpus grew to 33 underneath it, and the artifact
 * ended up disagreeing with its own separation counts in the same file. A disclaimer that goes stale
 * is worse than none: it reads as a measured bound and is a leftover.
 *
 * The count was not the only thing in it that could go stale. "Pages this project wrote" was true
 * until #203 put six it did not write into the corpus, so the split is derived too — from the
 * `third-party/` prefix the licence check already keys on, rather than from a second list.
 */
function disclaimer(cases) {
  const foreign = cases.filter((entry) => entry.file.startsWith("third-party/")).length;
  const written = cases.length - foreign;
  const where =
    foreign === 0
      ? `${written} pages this project wrote`
      : `${cases.length} pages — ${written} this project wrote and ${foreign} it did not`;
  return `Calibrated against ${where}. Separation on them is not evidence about pages nobody here has seen.`;
}

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
      // A page detected only by low-confidence signals scores zero the moment low confidence is
      // discounted, which is what two sensitivity variants do. Recorded per case so the failure has
      // a name rather than being a margin of 0 in a table.
      lowConfidenceOnly:
        report.findings.length > 0 &&
        report.findings.every((finding) => finding.confidence === "low"),
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
 * **The mirror case is excluded for the same reason, and it took an adversarial page to find it.**
 * A clean page the rules fired on scores like a problem page, because that is what the index is
 * for — it weighs findings and cannot know one was wrong. Counting it here would report a precision
 * failure as a scoring failure, and the corpus evaluation is where precision is counted. The
 * exclusion was one-sided until the corpus contained a false positive, at which point separation
 * broke and pointed at the wrong component.
 *
 * So the claim is: **among the problem pages the rules detected, every one scores above every clean
 * page the rules stayed quiet on**. Both excluded sets are listed rather than averaged away.
 *
 * That is a **weak claim**, and it is worth saying so: with the exclusions, every remaining clean
 * page scores zero, so it reduces to "a detected problem scores above nothing". It can still fail —
 * a model that scored a detected finding at zero would break it — but the interesting failures on
 * this corpus are precision and recall, and neither of them lives here.
 *
 * `margin` is the gap. Zero or negative means the model ranks a clean page at or above a detected
 * bad one, which should stop a release rather than be rounded away.
 */
function separationOf(cases) {
  const positives = cases.filter((entry) => entry.kind === "positive" && entry.score !== null);
  const detected = positives.filter((entry) => entry.findingCount > 0);
  const undetected = positives.filter((entry) => entry.findingCount === 0);
  const negatives = cases.filter((entry) => entry.kind === "negative" && entry.score !== null);
  const quiet = negatives.filter((entry) => entry.findingCount === 0);
  const misfired = negatives.filter((entry) => entry.findingCount > 0);
  const minDetected = Math.min(...detected.map((entry) => entry.score));
  const maxQuiet = quiet.length === 0 ? 0 : Math.max(...quiet.map((entry) => entry.score));
  return {
    problemPages: positives.length,
    detectedProblemPages: detected.length,
    undetectedProblemPages: undetected.map((entry) => entry.id),
    cleanPages: negatives.length,
    quietCleanPages: quiet.length,
    // Clean pages a rule fired on. Their scores are correct arithmetic over incorrect findings.
    falsePositivePages: misfired.map((entry) => ({ id: entry.id, score: entry.score })),
    minDetectedScore: Number.isFinite(minDetected) ? minDetected : null,
    maxCleanScore: maxQuiet,
    margin: Number.isFinite(minDetected) ? minDetected - maxQuiet : null,
    separated: Number.isFinite(minDetected) && minDetected > maxQuiet,
  };
}

/**
 * Does the separation survive different weights?
 *
 * If it only holds at exactly the shipped constants, they were fitted to this corpus rather than
 * argued for, and that is worth knowing before the number ships. Each variant changes one thing.
 */
function sensitivity(base = DEFAULT_RISK_MODEL_PARAMETERS) {
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
    id: "worst-times-log-affected",
    label: "worst × log₂ affected (fairux-risk/2)",
    note: "What `fairux-risk/2` ships. The score doubles when the problem is on sixteen inputs, and one input scores exactly what fairux-risk/1 gives it.",
    aggregate: WORST_WITH_BREADTH,
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

/**
 * The claim `fairux-risk/2` has to carry that `fairux-risk/1` does not: it must not have bought
 * breadth by giving up separation.
 *
 * On a single page the two models are the same arithmetic — one affected input, no breadth term — so
 * agreement here is a property worth asserting rather than a coincidence worth noting. A difference
 * would mean the aggregation leaked into the single-input case, where there is nothing to aggregate.
 */
function secondModel() {
  const cases = scoreCases(fairuxRiskIndexModelV2);
  const base = scoreCases(fairuxRiskIndexModel);
  const agreesOnSinglePages = cases.every((entry, index) => entry.score === base[index]?.score);
  const variants = sensitivity(RISK_MODEL_V2_PARAMETERS);
  return {
    modelVersion: fairuxRiskIndexModelV2.version,
    default: false,
    agreesWithV1OnSinglePages: agreesOnSinglePages,
    separation: separationOf(cases),
    sensitivity: variants,
  };
}

/**
 * A journey rule that exists only to be measured.
 *
 * The three questions in [#135](https://github.com/toshtag/fairux-linter/issues/135) all need a
 * cross-step finding to weigh, and the built-in rule set has none — which is why they have been
 * unanswerable rather than merely unanswered. A probe supplies one without shipping anything: it is
 * defined here, used here, and reaches no pack, no catalog, and no review record.
 *
 * It reports exactly one finding, at a severity and confidence the caller picks, anchored to a step
 * the caller picks. Everything about a real journey rule that would vary is held still, so a
 * difference between two rows is the model and nothing else.
 */
function probeJourneyRule({ stepId, severity, confidence }) {
  return {
    meta: {
      id: "probe/cross-step",
      title: "Cross-step probe",
      category: "hidden-cost",
      defaultSeverity: severity,
      defaultConfidence: confidence,
      defaultEnabled: true,
      tags: [],
      version: "1.0.0",
      maturity: "stable",
      requiredCapabilities: ["journey", "text"],
      evidenceRequirements: ["comparison", "sequence"],
    },
    evaluate: (_journey, ctx) => [
      ctx.createFinding({
        stepId,
        evidence: [{ stepId, text: "probe" }],
        description: "A probe finding, used to measure how a journey scores.",
        whyItMatters: "It exists to be weighed, and says nothing about any page.",
        recommendation: "Nothing. This rule ships nowhere.",
      }),
    ],
  };
}

/**
 * How a journey scores, measured rather than reasoned about.
 *
 * Three questions, and a flow built so each one has a visible answer: a step with a real problem, and
 * two clean steps beside it.
 */
function journeyScoring() {
  const manifest = JSON.parse(readFileSync(join(CORPUS_DIR, "manifest.json"), "utf8"));
  const byId = new Map(manifest.cases.map((entry) => [entry.id, entry]));
  const stepIds = ["clean-first", "problem-middle", "clean-last"];
  const caseIds = [
    "clean-informational-page-en",
    "consent-pre-checked-marketing-en",
    "clean-checkout-with-fees-en",
  ];

  const steps = caseIds.map((caseId, index) => ({
    id: stepIds[index],
    order: index + 1,
    document: parseHtml(readFileSync(join(CORPUS_DIR, byId.get(caseId).file), "utf8"), {
      file: byId.get(caseId).file,
    }),
  }));

  const score = (journeyRules) => {
    const report = scanJourneyWithRules(steps, journeyRules);
    const index = computeRiskIndex(report, {
      model: fairuxRiskIndexModel,
      toolVersion: "calibration",
      now: () => new Date("1970-01-01T00:00:00.000Z"),
    });
    return { score: index.score, crossStepFindings: report.findings.length };
  };

  const stepsOnly = score([]);
  const anchoredToQuietStep = score([
    probeJourneyRule({ stepId: "clean-first", severity: "medium", confidence: "high" }),
  ]);
  const anchoredToWorstStep = score([
    probeJourneyRule({ stepId: "problem-middle", severity: "medium", confidence: "high" }),
  ]);

  return {
    // Every real journey is in this state: no built-in journey rule, so the flow's own layer is empty
    // and the score comes entirely from the steps.
    stepsOnly,
    anchoredToQuietStep,
    anchoredToWorstStep,
    // Q3, and the answer is worse than "it might". Anchoring is documented as where a reader should
    // look; it also decides which pool the finding lands in, and a pool that is not the worst one
    // contributes nothing.
    anchoringChangesScore: anchoredToQuietStep.score !== anchoredToWorstStep.score,
    crossStepFindingIgnoredOnAQuietStep: anchoredToQuietStep.score === stepsOnly.score,
    // Q1: when it does land in the worst pool, what is it worth? A medium finding at high confidence
    // contributes 10 — the same as a page finding of the same severity, so no, not more.
    worthOnTheWorstStep: anchoredToWorstStep.score - stepsOnly.score,
    // Q2: the model asks for `structure` and `text`. It does not ask for `journey`, so a flow is
    // gated exactly as a page is.
    modelRequiresJourneyCapability: fairuxRiskIndexModel.requiredCapabilities.includes("journey"),
  };
}

function scanJourneyWithRules(steps, journeyRules) {
  return createScanner({
    rulePacks: [
      fairuxBuiltinRulePack,
      // Composition refuses `journeyRules: []` — absent already says that — so the probe pack is
      // present only when there is a probe to put in it.
      ...(journeyRules.length === 0
        ? []
        : [
            {
              meta: {
                id: "@probe/journey",
                version: "0.0.0-probe.0",
                engineApiVersion: "1",
                title: "Calibration probe",
                status: "stable",
              },
              rules: [],
              journeyRules,
            },
          ]),
    ],
    includeExperimental: false,
    toolVersion: "calibration",
    now: () => new Date("1970-01-01T00:00:00.000Z"),
  }).scanJourney({ steps });
}

/**
 * Whether this corpus says anything about the weights at all.
 *
 * Every sensitivity variant separating reads like a robustness result and is not one. On a corpus
 * where every clean page scores exactly zero, *any* non-negative weighting separates — the claim is
 * carried by "clean pages produce no findings", not by the ratios between `high`, `medium`, `low`,
 * and `info`. Saying so is the difference between a calibration and a number with a table under it.
 */
function sensitivityVerdict(separation, variants, cases) {
  const failing = variants
    .filter((variant) => !variant.separation.separated)
    .map((variant) => variant.variant);
  const cleanPagesAllZero = separation.maxCleanScore === 0;
  const carriedByLowConfidence = cases
    .filter((entry) => entry.kind === "positive" && entry.lowConfidenceOnly)
    .map((entry) => entry.id);
  return {
    failingVariants: failing,
    cleanPagesAllZero,
    // Load-bearing means a variant could have failed on the *clean* side. It cannot while no clean
    // page scores at all: any non-negative weighting separates zero from non-zero.
    severityWeightsAreLoadBearing: !cleanPagesAllZero,
    carriedByLowConfidence,
    notes: [
      cleanPagesAllZero
        ? "Every clean page scores 0, so any non-negative severity weighting separates. The separation is evidence about detection, not about the ratios between high, medium, low, and info. Pages carrying findings of mixed severity — which this corpus does not have — are what would make those weights testable."
        : "At least one clean page scores above zero, so a variant could have failed on the clean side.",
      carriedByLowConfidence.length > 0
        ? `The confidence factors, unlike the severity weights, are load-bearing: ${carriedByLowConfidence.join(", ")} ${carriedByLowConfidence.length === 1 ? "is" : "are"} detected only by low-confidence findings, and score 0 under any variant that discounts them. That is why ${failing.length} variant${failing.length === 1 ? "" : "s"} below do${failing.length === 1 ? "es" : ""} not separate. The shipped model counts low confidence at 0.3, so it does separate — but the claim rests on that constant, not only on detection.`
        : "No labelled problem page is detected solely by low-confidence findings.",
    ],
  };
}

function build() {
  const cases = scoreCases(fairuxRiskIndexModel);
  const collections = scoreCollections();
  const separation = separationOf(cases);
  const variants = sensitivity();
  return {
    schemaVersion: 1,
    disclaimer: disclaimer(
      JSON.parse(readFileSync(join(CORPUS_DIR, "manifest.json"), "utf8")).cases,
    ),
    modelVersion: fairuxRiskIndexModel.version,
    parameters: {
      severityWeights: DEFAULT_RISK_MODEL_PARAMETERS.severityWeights,
      confidenceFactors: DEFAULT_RISK_MODEL_PARAMETERS.confidenceFactors,
    },
    separation,
    sensitivity: variants,
    // What the sensitivity table means, computed rather than asserted. Every variant separating is
    // not the same as the weights being right — see `weightsAreLoadBearing`.
    sensitivityVerdict: sensitivityVerdict(separation, variants, cases),
    journeyScoring: journeyScoring(),
    secondModel: secondModel(),
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
    "page **the rules stayed quiet on**. Two sets are excluded, for the same reason in both",
    "directions — a scoring claim cannot be made to carry a detection result.",
    "",
    "- A page whose problem was never found scores zero, and no arrangement of weights can rank it",
    "  above a clean page. That is a recall failure.",
    "- A clean page a rule fired on scores like a problem page, because the index weighs findings and",
    "  cannot know one was wrong. That is a precision failure.",
    "",
    "Both are counted by the [corpus evaluation](corpus-evaluation.md), and both are listed below",
    "rather than averaged away.",
    "",
    "**This is a weak claim.** With those exclusions every remaining clean page scores zero, so it",
    'reduces to "a detected problem scores above nothing". It can still fail, and it is not the',
    "measurement that would tell you the weights are right — nothing here is.",
    "",
    "| Measure | Value |",
    "| --- | --- |",
    `| Pages with a labelled problem | ${result.separation.problemPages} |`,
    `| …of those, detected by the rules | ${result.separation.detectedProblemPages} |`,
    `| Pages labelled clean | ${result.separation.cleanPages} |`,
    `| …of those, the rules stayed quiet on | ${result.separation.quietCleanPages} |`,
    `| Lowest score among detected problem pages | ${result.separation.minDetectedScore} |`,
    `| Highest score among clean pages | ${result.separation.maxCleanScore} |`,
    `| Margin | ${result.separation.margin} |`,
    `| Separated | ${result.separation.separated ? "yes" : "**no**"} |`,
    "",
    "### Clean pages a rule fired on",
    "",
    result.separation.falsePositivePages.length === 0
      ? "None."
      : `${result.separation.falsePositivePages
          .map((entry) => `\`${entry.id}\` (${entry.score})`)
          .join(
            ", ",
          )} — labelled clean, and scored on findings that should not exist. The arithmetic is right and the input is wrong, which is a precision problem and not a scoring one.`,
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
    "they would be fitted to this corpus rather than argued for.",
    "",
    ...result.sensitivityVerdict.notes.map((note) => `**${note}**\n`),
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
    "## `fairux-risk/2`",
    "",
    `Same weights, an aggregation that can see breadth. **${result.secondModel.default ? "The default" : "Not the default"}** — two scores are`,
    "comparable when their `modelVersion` matches and not otherwise, so changing what a bare",
    "`computeRiskIndex` returns changes what every existing number meant.",
    "",
    "| Measure | `fairux-risk/1` | `fairux-risk/2` |",
    "| --- | --- | --- |",
    `| Margin | ${result.separation.margin} | ${result.secondModel.separation.margin} |`,
    `| Separated | ${result.separation.separated ? "yes" : "**no**"} | ${result.secondModel.separation.separated ? "yes" : "**no**"} |`,
    `| Agrees with \`fairux-risk/1\` on every single-page case | — | ${result.secondModel.agreesWithV1OnSinglePages ? "yes" : "**no**"} |`,
    "",
    "The agreement is the property, not a coincidence: on one input there is nothing to aggregate, so",
    "the breadth term must contribute exactly nothing. A difference there would mean it had leaked",
    "into the case it is not about.",
    "",
    "Its separation survives the same weight perturbations:",
    "",
    "| Variant | Margin | Separated |",
    "| --- | --- | --- |",
  );
  for (const variant of result.secondModel.sensitivity) {
    lines.push(
      `| ${variant.variant} | ${variant.separation.margin} | ${variant.separation.separated ? "yes" : "**no**"} |`,
    );
  }

  lines.push(
    "",
    "## How a journey scores",
    "",
    "Three questions that needed a cross-step finding to weigh, and no built-in journey rule produces",
    "one. A probe rule supplies one here — defined in the harness, used in the harness, reaching no",
    "pack and no review record. The flow below is three steps: a clean page, a page with a pre-checked",
    "consent box, and a clean checkout.",
    "",
    "| Run | Cross-step findings | Score |",
    "| --- | --- | --- |",
    `| Steps only, which is every real journey today | ${result.journeyScoring.stepsOnly.crossStepFindings} | ${result.journeyScoring.stepsOnly.score} |`,
    `| One medium/high cross-step finding, anchored to a **quiet** step | ${result.journeyScoring.anchoredToQuietStep.crossStepFindings} | ${result.journeyScoring.anchoredToQuietStep.score} |`,
    `| The same finding, anchored to the **worst** step | ${result.journeyScoring.anchoredToWorstStep.crossStepFindings} | ${result.journeyScoring.anchoredToWorstStep.score} |`,
    "",
    "**Anchoring decides the number**, and not by a little. The same finding from the same rule is",
    result.journeyScoring.crossStepFindingIgnoredOnAQuietStep
      ? "worth nothing at all on a quiet step, and " +
          `${result.journeyScoring.worthOnTheWorstStep} on the worst one.`
      : `worth ${result.journeyScoring.worthOnTheWorstStep} more on the worst step than on a quiet one.`,
    "",
    "That is a conflation, and the report schema names both halves of it separately: a journey",
    "finding's `stepId` is **where a reader should look**, and the aggregation reads it as **which",
    "input the finding belongs to**. A rule anchoring a cross-step finding to the step where the",
    "problem becomes visible — the natural choice, and the one the schema asks for — can make its own",
    "finding invisible to the score.",
    "",
    `Asked and answered: a cross-step finding is **not** worth more than a page finding (${result.journeyScoring.worthOnTheWorstStep} for a`,
    "medium at high confidence, exactly what a page finding of that severity contributes), and the",
    `journey's own coverage does **not** gate the score — the model requires \`structure\` and`,
    `\`text\` and ${result.journeyScoring.modelRequiresJourneyCapability ? "does" : "does not"} require \`journey\`, so a flow is gated exactly as a page is.`,
    "",
    "None of this changes `fairux-risk/1`. A journey finding that formed its own pool rather than",
    "joining a step's would be a different aggregation, and a different aggregation is a different",
    "`modelVersion`.",
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
