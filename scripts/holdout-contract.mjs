/**
 * What an external holdout package has to be, and what a score over it may claim.
 *
 * `P7` in [the release criteria](../docs/maintainers/release-criteria.md) asks for detection quality
 * on inputs this project has not tuned against, and writes down four conditions so that a smaller
 * thing cannot close it: per-rule minimums both ways, stratification by locale and runtime,
 * immutability once evaluated, and an uncertainty interval reported with the number.
 *
 * This module is those four conditions as code. Nothing here scans anything or touches a
 * filesystem — it takes labels, counts, and digests, and answers whether they add up to a
 * measurement. `scripts/evaluate-holdout.mjs` is the half that reads files.
 *
 * **Every refusal is fail-closed.** A package that cannot be checked is refused rather than scored
 * with a caveat: the failure this exists to prevent is a number that gets quoted without the
 * sentence beside it, and a caveat is the part that does not travel.
 *
 * **The holdout is read-only evidence.** Nothing in this module or its runner writes into the
 * package or into `corpus/`. A holdout that gets edited after a disappointing result is a corpus,
 * and one that contributes a rule fix has become training data — which is exactly what happened to
 * the six third-party fixtures, and is why they cannot close `P7`.
 */

import { createHash } from "node:crypto";

/** What this module knows how to read. A package declaring anything else is refused, not guessed at. */
export const HOLDOUT_SCHEMA_VERSION = 1;

/**
 * What a package's numbers are allowed to be used for.
 *
 * `harness-fixture` exists because this harness needs tests, and a synthetic package written to
 * exercise the harness is written by the same people who wrote the rules — which is the one thing a
 * holdout may not be. It is a required field rather than an inferred one: a package with no answer
 * is refused, so the permissive value can never be the default.
 */
export const EVIDENCE_CLASSES = Object.freeze({
  /** Assembled by somebody outside this repository. The only class that can bear on `P7`. */
  EXTERNAL: "external-holdout",
  /** Written here, to test this harness. Never evidence about detection quality. */
  FIXTURE: "harness-fixture",
});

/**
 * The runtimes a package has to cover, from the criterion rather than from convenience.
 *
 * `P7` names HTML, JSX/TSX and Figma because they are different adapters with different
 * capabilities, and a rule that works on one says nothing about the others. `dom` is deliberately
 * absent: it is the live-DOM adapter, and a holdout is files.
 */
export const REQUIRED_RUNTIMES = Object.freeze(["html", "ast", "figma"]);

/** 95%. Two-sided, and stated as a number so the interval below is reproducible by hand. */
export const WILSON_Z = 1.959963984540054;

/**
 * The lower bound a perfect score has to clear before a count is worth reporting.
 *
 * This is the one judgement in the file, and it is here rather than expressed as a sample count so
 * that the count follows from it. 0.7 is the claim "this rule is right most of the time" — below
 * it, a rule with every case correct still cannot be distinguished from one that is wrong three
 * times in ten, and reporting a point estimate from that many samples invites exactly the quotation
 * `P7` exists to prevent.
 *
 * {@link minimumSamplesPerRule} derives the count. Argue with the 0.7; the number of pages an
 * external preparer has to assemble is downstream of it.
 */
export const MIN_LOWER_BOUND_AT_PERFECT = 0.7;

/** Three decimals, which is where these numbers stop meaning anything anyway. */
function round(value) {
  return Math.round(value * 1000) / 1000;
}

/**
 * A Wilson score interval, and the count it rests on.
 *
 * Wilson rather than the normal approximation, for the reason that matters here: at the extremes —
 * every case right, or every case wrong — the normal interval has zero width and reports certainty
 * from a handful of samples. Wilson does not, which is the whole point of putting an interval
 * beside a first score.
 *
 * `trials` travels with the interval because "precision 0.82" from 40 labelled positives is a
 * different claim from the same number over 400, and the version without the count is the one that
 * gets quoted.
 *
 * @param {number} successes
 * @param {number} trials
 * @returns {{point: number, lower: number, upper: number, trials: number} | null} `null` when there
 *   was nothing to measure — which is not the same as a rate of zero.
 */
export function wilsonInterval(successes, trials) {
  if (trials === 0) return null;
  const proportion = successes / trials;
  const zSquared = WILSON_Z * WILSON_Z;
  const denominator = 1 + zSquared / trials;
  const centre = (proportion + zSquared / (2 * trials)) / denominator;
  const halfWidth =
    (WILSON_Z / denominator) *
    Math.sqrt((proportion * (1 - proportion)) / trials + zSquared / (4 * trials * trials));
  return {
    point: round(proportion),
    lower: round(Math.max(0, centre - halfWidth)),
    upper: round(Math.min(1, centre + halfWidth)),
    trials,
  };
}

/**
 * The fewest samples per rule, in each direction, that {@link MIN_LOWER_BOUND_AT_PERFECT} allows.
 *
 * Derived rather than written down, so the constant somebody argues with is the one that carries the
 * argument. The search is bounded because an unreachable threshold should fail loudly rather than
 * spin.
 */
export function minimumSamplesPerRule() {
  for (let trials = 1; trials <= 10_000; trials += 1) {
    const interval = wilsonInterval(trials, trials);
    if (interval && interval.lower >= MIN_LOWER_BOUND_AT_PERFECT) return trials;
  }
  throw new Error(
    `no sample count reaches a lower bound of ${MIN_LOWER_BOUND_AT_PERFECT} — the threshold is unreachable`,
  );
}

/** Object keys sorted at every depth, so a digest describes content rather than authoring order. */
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : 1))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value === undefined ? null : value);
}

/**
 * The seal: one digest over the labels and every byte they describe.
 *
 * Over both halves deliberately. A digest of the files alone would let a label be rewritten after a
 * disappointing result — which is the failure mode `P7`'s third condition is about, and the one
 * that leaves no trace. A digest of the manifest alone would let a page be edited under its label.
 *
 * The manifest's own `seal` is excluded, because it cannot contain its own digest.
 *
 * @param {object} manifest
 * @param {Map<string, string | Uint8Array>} contentsById  every sample's bytes, by sample id
 */
export function sealDigest(manifest, contentsById) {
  const hash = createHash("sha256");
  // Domain-separated: a digest that could be produced by hashing something else is a digest that
  // can be replayed from something else.
  hash.update(`fairux-holdout/${HOLDOUT_SCHEMA_VERSION}\n`);
  hash.update(canonicalJson({ ...manifest, seal: undefined }));
  hash.update("\n");
  for (const id of [...contentsById.keys()].sort()) {
    hash.update(id);
    hash.update("\n");
    hash.update(createHash("sha256").update(contentsById.get(id)).digest("hex"));
    hash.update("\n");
  }
  return hash.digest("hex");
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * A path that stays inside the package.
 *
 * A holdout is prepared by somebody outside this repository, so its manifest is untrusted input
 * that names files this process opens. Absolute paths and `..` segments are refused here rather
 * than resolved and compared later: the refusal has to come before the read.
 */
function isContainedRelativePath(value) {
  if (!isNonEmptyString(value)) return false;
  if (value.startsWith("/") || /^[A-Za-z]:/.test(value) || value.startsWith("\\")) return false;
  return !value.split(/[/\\]/).includes("..");
}

/**
 * Everything wrong with a manifest's shape, as sentences.
 *
 * Every problem is reported rather than the first one: an external preparer fixing a package one
 * refusal per run is a preparer who stops.
 *
 * @param {unknown} manifest
 * @param {{locales: readonly string[], ruleIds: readonly string[]}} vocabulary  what the rule set
 *   currently ships, so a label naming a rule or a locale that does not exist is refused rather
 *   than silently scoring nothing
 */
export function manifestRefusals(manifest, vocabulary) {
  const refusals = [];
  if (!manifest || typeof manifest !== "object") return ["the manifest is not an object"];

  if (manifest.schemaVersion !== HOLDOUT_SCHEMA_VERSION) {
    refusals.push(
      `schemaVersion is ${JSON.stringify(manifest.schemaVersion)}, and this evaluator reads ${HOLDOUT_SCHEMA_VERSION}`,
    );
  }
  const classes = Object.values(EVIDENCE_CLASSES);
  if (!classes.includes(manifest.evidenceClass)) {
    refusals.push(
      `evidenceClass is ${JSON.stringify(manifest.evidenceClass)}, and must be one of ${classes.join(", ")}`,
    );
  }
  for (const field of ["packageId", "preparedBy", "preparedAt"]) {
    if (!isNonEmptyString(manifest[field])) refusals.push(`${field} is missing`);
  }
  if (isNonEmptyString(manifest.preparedAt) && Number.isNaN(Date.parse(manifest.preparedAt))) {
    refusals.push(`preparedAt is not a date: ${JSON.stringify(manifest.preparedAt)}`);
  }
  const seal = manifest.seal;
  if (!seal || seal.algorithm !== "sha256" || !/^[0-9a-f]{64}$/.test(seal.digest ?? "")) {
    refusals.push("seal is missing, or is not a sha256 digest — run the evaluator with --seal");
  }

  if (!Array.isArray(manifest.samples) || manifest.samples.length === 0) {
    refusals.push("samples is missing or empty");
    return refusals;
  }

  const seenIds = new Set();
  const knownRules = new Set(vocabulary.ruleIds);
  for (const [position, sample] of manifest.samples.entries()) {
    const where = isNonEmptyString(sample?.id) ? sample.id : `sample ${position}`;
    if (!isNonEmptyString(sample?.id)) refusals.push(`${where}: id is missing`);
    else if (seenIds.has(sample.id)) refusals.push(`${where}: id appears more than once`);
    else seenIds.add(sample.id);

    if (!isContainedRelativePath(sample?.file)) {
      refusals.push(`${where}: file must be a relative path inside the package`);
    }
    if (!isNonEmptyString(sample?.summary)) {
      refusals.push(
        `${where}: summary is missing — a label nobody can read is a label nobody can check`,
      );
    }
    if (!vocabulary.locales.includes(sample?.locale)) {
      refusals.push(
        `${where}: locale ${JSON.stringify(sample?.locale)} is not one this rule set ships (${vocabulary.locales.join(", ")})`,
      );
    }
    if (!REQUIRED_RUNTIMES.includes(sample?.runtime)) {
      refusals.push(
        `${where}: runtime ${JSON.stringify(sample?.runtime)} must be one of ${REQUIRED_RUNTIMES.join(", ")}`,
      );
    }

    const expected = sample?.expected;
    if (!Array.isArray(expected)) {
      refusals.push(`${where}: expected must be an array, empty if the page should stay quiet`);
    } else {
      for (const item of expected) {
        if (!knownRules.has(item?.ruleId)) {
          refusals.push(
            `${where}: expected names ${JSON.stringify(item?.ruleId)}, which is not a rule`,
          );
        }
        if (!Number.isInteger(item?.count) || item.count < 1) {
          refusals.push(`${where}: expected ${item?.ruleId} needs a count of at least 1`);
        }
      }
    }

    const negativeFor = sample?.negativeFor;
    if (!Array.isArray(negativeFor)) {
      refusals.push(`${where}: negativeFor must be an array`);
    } else {
      const positives = new Set(
        (Array.isArray(expected) ? expected : []).map((item) => item?.ruleId),
      );
      for (const ruleId of negativeFor) {
        if (!knownRules.has(ruleId)) {
          refusals.push(
            `${where}: negativeFor names ${JSON.stringify(ruleId)}, which is not a rule`,
          );
        }
        if (positives.has(ruleId)) {
          refusals.push(`${where}: ${ruleId} is both expected and declared a near miss`);
        }
      }
    }
  }
  return refusals;
}

/**
 * Whether the package measures enough to be worth a number, per rule and per stratum.
 *
 * A sample counts as a **positive** for a rule when its label expects that rule, and as a
 * **negative** only when it says so in `negativeFor`. Incidental silence is not a negative: a page
 * about train timetables says nothing about a consent rule's false-positive rate, and counting it
 * would let a package satisfy the negative minimum by containing unrelated pages. `negativeFor` is
 * a claim the preparer makes — this page looks like one this rule should fire on, and it must not.
 *
 * @param {{samples: readonly object[]}} manifest
 * @param {{locales: readonly string[], ruleIds: readonly string[]}} vocabulary
 */
export function coverageRefusals(manifest, vocabulary) {
  const refusals = [];
  const minimum = minimumSamplesPerRule();
  const samples = manifest.samples ?? [];

  for (const ruleId of vocabulary.ruleIds) {
    const positives = samples.filter((sample) =>
      (sample.expected ?? []).some((item) => item.ruleId === ruleId),
    ).length;
    const negatives = samples.filter((sample) =>
      (sample.negativeFor ?? []).includes(ruleId),
    ).length;
    if (positives < minimum) {
      refusals.push(
        `${ruleId}: ${positives} positive sample(s), and ${minimum} are needed before a recall figure means anything`,
      );
    }
    if (negatives < minimum) {
      refusals.push(
        `${ruleId}: ${negatives} declared near miss(es), and ${minimum} are needed before a false-positive rate means anything`,
      );
    }
  }

  for (const locale of vocabulary.locales) {
    if (!samples.some((sample) => sample.locale === locale)) {
      refusals.push(`no ${locale} samples, and ${locale} is a dictionary this rule set ships`);
    }
  }
  for (const runtime of REQUIRED_RUNTIMES) {
    if (!samples.some((sample) => sample.runtime === runtime)) {
      refusals.push(
        `no ${runtime} samples, and a rule that works on one adapter says nothing about another`,
      );
    }
  }
  return refusals;
}

/**
 * Turn scored samples into the numbers a report may carry.
 *
 * Takes scoring that has already happened, so this stays a function of counts and can be driven from
 * a test without a scanner. Occurrence counts for precision and recall, matching what
 * `scripts/evaluate-corpus.mjs` reports, so the two numbers are comparable — a holdout score lower
 * than the corpus score is the expected outcome, and it is only readable as such if the two are
 * measured the same way.
 *
 * True negatives are counted per **sample**, not per occurrence: a page a rule stayed quiet on is
 * one observation, and there is no such thing as staying quiet twice.
 *
 * @param {readonly {
 *   id: string, locale: string, runtime: string,
 *   expected: readonly {ruleId: string, count: number}[],
 *   negativeFor: readonly string[],
 *   truePositives: readonly {ruleId: string, count: number}[],
 *   falsePositives: readonly {ruleId: string, count: number}[],
 *   falseNegatives: readonly {ruleId: string, count: number}[],
 * }[]} scored
 * @param {readonly string[]} ruleIds  every stable rule, so one that was never exercised appears
 *   as a row saying so rather than being absent
 */
export function summarise(scored, ruleIds) {
  const blank = () => ({
    truePositives: 0,
    falsePositives: 0,
    falseNegatives: 0,
    trueNegatives: 0,
    positiveSamples: 0,
    negativeSamples: 0,
  });
  const byRule = new Map(ruleIds.map((ruleId) => [ruleId, { ruleId, ...blank() }]));
  const byStratum = new Map();

  const sumOf = (items, ruleId) =>
    items.filter((item) => item.ruleId === ruleId).reduce((total, item) => total + item.count, 0);

  for (const sample of scored) {
    const key = `${sample.locale}/${sample.runtime}`;
    const stratum = byStratum.get(key) ?? {
      locale: sample.locale,
      runtime: sample.runtime,
      samples: 0,
      ...blank(),
    };
    stratum.samples += 1;

    for (const ruleId of ruleIds) {
      const rule = byRule.get(ruleId);
      const truePositives = sumOf(sample.truePositives, ruleId);
      const falsePositives = sumOf(sample.falsePositives, ruleId);
      const falseNegatives = sumOf(sample.falseNegatives, ruleId);
      const isPositive = sample.expected.some((item) => item.ruleId === ruleId);
      const isNegative = sample.negativeFor.includes(ruleId);
      // A declared near miss the rule stayed quiet on. `falsePositives` is what it looks like when
      // it did not, so the two are read from the same run rather than from two definitions.
      const trueNegative = isNegative && falsePositives === 0 ? 1 : 0;

      for (const target of [rule, stratum]) {
        target.truePositives += truePositives;
        target.falsePositives += falsePositives;
        target.falseNegatives += falseNegatives;
        target.trueNegatives += trueNegative;
        target.positiveSamples += isPositive ? 1 : 0;
        target.negativeSamples += isNegative ? 1 : 0;
      }
    }
    byStratum.set(key, stratum);
  }

  const withRates = (row) => ({
    ...row,
    precision: wilsonInterval(row.truePositives, row.truePositives + row.falsePositives),
    recall: wilsonInterval(row.truePositives, row.truePositives + row.falseNegatives),
    // Over declared near misses only, which is the denominator that answers "how often is this rule
    // wrong on a page built to look like one it should fire on".
    specificity: wilsonInterval(row.trueNegatives, row.negativeSamples),
  });

  const totals = [...byRule.values()].reduce((all, row) => {
    for (const key of Object.keys(blank())) all[key] += row[key];
    return all;
  }, blank());

  return {
    totals: { samples: scored.length, ...withRates(totals) },
    byRule: [...byRule.values()]
      .sort((left, right) => (left.ruleId < right.ruleId ? -1 : 1))
      .map(withRates),
    byStratum: [...byStratum.values()]
      .sort((left, right) =>
        `${left.locale}/${left.runtime}`.localeCompare(`${right.locale}/${right.runtime}`),
      )
      .map(withRates),
  };
}
