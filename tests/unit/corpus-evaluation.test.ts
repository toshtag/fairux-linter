import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
// @ts-expect-error — same.
import { separationOf } from "../../scripts/calibrate-risk-index.mjs";
// @ts-expect-error — the harness is plain JS, like every other generator script here.
import { scoreCase } from "../../scripts/evaluate-corpus.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");

interface ManifestCase {
  readonly id: string;
  readonly file: string;
  readonly locale: string;
  readonly kind: "positive" | "negative";
  readonly summary: string;
  readonly expected: readonly { readonly ruleId: string; readonly count: number }[];
  readonly tolerated?: readonly { readonly ruleId: string; readonly why: string }[];
}

interface ManifestCollection {
  readonly id: string;
  readonly kind: "multi-input" | "journey";
  readonly summary: string;
  readonly caseIds: readonly string[];
}

const manifest = JSON.parse(readFileSync(join(ROOT, "corpus/manifest.json"), "utf8")) as {
  readonly cases: readonly ManifestCase[];
  readonly collections: readonly ManifestCollection[];
};

const evaluation = JSON.parse(
  readFileSync(join(ROOT, "docs/generated/corpus-evaluation.json"), "utf8"),
) as {
  readonly totals: Record<string, number | null>;
  readonly cases: readonly { readonly id: string }[];
  readonly byRule: readonly { readonly ruleId: string }[];
};

/**
 * The harness counts the numbers everything else in this milestone will be read against, so its
 * arithmetic is pinned rather than trusted. A miscount here would be invisible: every artifact it
 * writes would still be internally consistent and still be wrong.
 */
describe("corpus scoring", () => {
  const entry = (over: Partial<ManifestCase> = {}) => ({
    id: "case",
    kind: "positive",
    locale: "en",
    expected: [{ ruleId: "a/one", count: 1 }],
    ...over,
  });

  it("credits an expected finding that fired", () => {
    const scored = scoreCase(entry(), new Map([["a/one", 1]]));
    expect(scored.truePositives).toEqual([{ ruleId: "a/one", count: 1 }]);
    expect(scored.falsePositives).toEqual([]);
    expect(scored.falseNegatives).toEqual([]);
  });

  it("records a miss when an expected finding did not fire", () => {
    const scored = scoreCase(entry(), new Map());
    expect(scored.truePositives).toEqual([]);
    expect(scored.falseNegatives).toEqual([{ ruleId: "a/one", count: 1 }]);
  });

  it("counts an unexpected rule as a false positive", () => {
    const scored = scoreCase(entry({ expected: [] }), new Map([["a/two", 1]]));
    expect(scored.falsePositives).toEqual([{ ruleId: "a/two", count: 1 }]);
  });

  it("counts the excess when a rule fired more often than labelled", () => {
    // A duplicate finding is noise someone has to dismiss, so the extra is charged rather than
    // absorbed into the match.
    const scored = scoreCase(entry(), new Map([["a/one", 3]]));
    expect(scored.truePositives).toEqual([{ ruleId: "a/one", count: 1 }]);
    expect(scored.falsePositives).toEqual([{ ruleId: "a/one", count: 2 }]);
  });

  it("credits a tolerated rule neither way", () => {
    const scored = scoreCase(
      entry({ expected: [], tolerated: [{ ruleId: "a/three", why: "borderline" }] }),
      new Map([["a/three", 1]]),
    );
    expect(scored.falsePositives).toEqual([]);
    expect(scored.truePositives).toEqual([]);
    expect(scored.tolerated).toEqual([{ ruleId: "a/three", count: 1 }]);
  });
});

describe("the corpus manifest", () => {
  it("gives every case a unique id and a summary", () => {
    const ids = manifest.cases.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const entry of manifest.cases) expect(entry.summary.trim()).not.toBe("");
  });

  it("labels positives with something to find and negatives with nothing", () => {
    for (const entry of manifest.cases) {
      if (entry.kind === "positive") expect(entry.expected.length).toBeGreaterThan(0);
      else expect(entry.expected).toEqual([]);
    }
  });

  it("requires a written reason on every tolerated finding", () => {
    // Without one, "tolerated" is just a way to hide a disagreement from the totals.
    for (const entry of manifest.cases) {
      for (const item of entry.tolerated ?? []) expect(item.why.trim().length).toBeGreaterThan(20);
    }
  });

  it("keeps negatives as a real share of the corpus", () => {
    // A rule that fires everywhere is worse than one that fires nowhere, and only negative cases
    // can catch it. A corpus that drifted to positives would measure recall and call it quality.
    const negatives = manifest.cases.filter((entry) => entry.kind === "negative").length;
    expect(negatives / manifest.cases.length).toBeGreaterThanOrEqual(0.4);
  });

  it("covers both locales the dictionaries ship", () => {
    const locales = new Set(manifest.cases.map((entry) => entry.locale));
    expect(locales).toContain("en");
    expect(locales).toContain("ja");
  });
});

describe("the generated evaluation", () => {
  it("reports how much of the vocabulary the pages reach, and does not flatter it", () => {
    const coverage = evaluation.patternCoverage;
    expect(coverage.patterns).toBeGreaterThan(200);
    expect(coverage.reached).toBeLessThan(coverage.patterns);

    // The number is the point, not the target. Writing a page per unmatched pattern would raise it to
    // 1 and teach it to mean nothing — the pages would be derived from the patterns they test — so
    // this asserts the shape and the honesty, never a threshold to chase.
    expect(coverage.rate).toBeGreaterThan(0);
    expect(coverage.rate).toBeLessThan(1);
    const summed = coverage.byGroup.reduce(
      (total: number, group: { patterns: number }) => total + group.patterns,
      0,
    );
    expect(summed).toBe(coverage.patterns);
  });

  it("names the groups no page reaches at all", () => {
    // A group at zero is a rule whose vocabulary the corpus has never seen used. That is worth being
    // able to point at, and it is invisible in precision and recall — both are computed over the
    // rules that fired.
    const untouched = evaluation.patternCoverage.byGroup.filter(
      (group: { reached: number }) => group.reached === 0,
    );
    expect(untouched.length).toBeGreaterThan(0);
    for (const group of untouched) {
      expect(group.patterns, `${group.locale}.${group.group}`).toBeGreaterThan(0);
    }
  });
  it("scores every case in the manifest, and only those", () => {
    expect(evaluation.cases.map((entry) => entry.id).sort()).toEqual(
      manifest.cases.map((entry) => entry.id).sort(),
    );
  });

  it("keeps a row for every non-experimental built-in rule, measured or not", () => {
    // A rule missing from the table would read as "nothing to report" where the truth is
    // "never measured".
    expect(evaluation.byRule.length).toBeGreaterThanOrEqual(11);
  });

  it("states what the numbers do not mean", () => {
    const markdown = readFileSync(join(ROOT, "docs/generated/corpus-evaluation.md"), "utf8");
    expect(markdown).toContain("They are not an accuracy claim about pages nobody here has seen");
  });
});

const calibration = JSON.parse(
  readFileSync(join(ROOT, "docs/generated/risk-index-calibration.json"), "utf8"),
) as {
  readonly modelVersion: string;
  readonly separation: {
    readonly separated: boolean;
    readonly margin: number;
    readonly cleanPages: number;
    readonly maxCleanScore: number;
    readonly undetectedProblemPages: readonly string[];
    readonly detectedProblemPages: number;
    readonly problemPages: number;
  };
  readonly sensitivity: readonly {
    readonly variant: string;
    readonly separation: { readonly separated: boolean };
  }[];
  readonly cases: readonly { readonly id: string; readonly kind: string; readonly score: number }[];
};

describe("the Risk Index calibration", () => {
  it("separates detected problem pages from clean ones, with a margin above zero", () => {
    // Zero or negative would mean the model ranks a clean page at or above a detected bad one.
    expect(calibration.separation.separated).toBe(true);
    expect(calibration.separation.margin).toBeGreaterThan(0);
  });

  it("scores every clean page at zero, except the ones a rule fired on", () => {
    // Not a property of the model — a consequence of the rules being quiet. The adversarial cases
    // made that visible by producing the exception, which is why the assertion now has to name it.
    const misfired = new Set(calibration.separation.falsePositivePages.map((entry) => entry.id));
    for (const entry of calibration.cases) {
      if (entry.kind !== "negative") continue;
      if (misfired.has(entry.id)) expect(entry.score).toBeGreaterThan(0);
      else expect(entry.score, entry.id).toBe(0);
    }
  });

  it("makes its claim only over the clean pages the rules stayed quiet on", () => {
    // The invariants, which hold whether or not any rule is currently misfiring. The first version
    // asserted `falsePositivePages.length > 0` — true when the adversarial pages found five false
    // positives, and false the moment they were fixed. A test that only passes while a defect exists
    // is a test that fights its own fix; the mechanism is exercised directly below instead.
    expect(calibration.separation.quietCleanPages).toBe(
      calibration.separation.cleanPages - calibration.separation.falsePositivePages.length,
    );
    expect(calibration.separation.maxCleanScore).toBe(0);
    for (const entry of calibration.separation.falsePositivePages) {
      expect(entry.score).toBeGreaterThan(0);
    }
  });

  it("excludes a clean page a rule fired on, whether or not one exists today", () => {
    // A clean page the rules misfired on scores like a problem page — correct arithmetic over
    // incorrect findings — and counting it would report a precision failure as a scoring failure.
    // Driven with synthetic cases so the exclusion stays covered on a corpus with nothing wrong.
    const result = separationOf([
      { id: "detected-problem", kind: "positive", score: 20, findingCount: 1 },
      { id: "quiet-clean", kind: "negative", score: 0, findingCount: 0 },
      { id: "misfired-clean", kind: "negative", score: 40, findingCount: 2 },
    ]) as typeof calibration.separation;

    expect(result.separated).toBe(true);
    expect(result.margin).toBe(20);
    expect(result.maxCleanScore).toBe(0);
    expect(result.quietCleanPages).toBe(1);
    expect(result.falsePositivePages).toEqual([{ id: "misfired-clean", score: 40 }]);
  });

  it("names the pages it is silent about rather than averaging them away", () => {
    // A page whose problem was never detected scores zero, and no weights can rank it above a clean
    // page. That is a recall failure, and the index has to say so by name rather than let the page
    // sit among the clean ones.
    //
    // The list has now been empty, then not, then empty again: an unbounded `/プラン.*変更/` bridged
    // two distant words on a Japanese account page and silenced the rule (#187). The assertion is
    // worth keeping precisely because it has already caught one regression that produced no wrong
    // output — only missing output.
    expect(calibration.separation.undetectedProblemPages).toEqual([]);
    expect(calibration.separation.detectedProblemPages).toBe(calibration.separation.problemPages);
  });

  it("records which weight changes break the separation", () => {
    const broken = calibration.sensitivity
      .filter((variant) => !variant.separation.separated)
      .map((variant) => variant.variant);
    // The useful result: the severity ladder is not load-bearing on this corpus, and the confidence
    // floor is. That is the argument for 0.3 rather than 0, and it is measured rather than asserted.
    expect(broken).toEqual(["low confidence dropped", "confidence dominant"]);
    // And the artifact says so where a reader will see it. This lived only in this comment, so the
    // published calibration showed two rows reading "**no**" and left the interpretation to whoever
    // happened to open the test file.
    expect(calibration.sensitivityVerdict.failingVariants).toEqual(broken);
  });

  it("names the pages the confidence floor is holding up", () => {
    // Which pages, not just which variants. Both are detected by exactly one low-confidence finding,
    // so they score 0 the moment low confidence is discounted — that is the whole reason two
    // variants fail, and without the names it reads as a property of the weights rather than of two
    // specific pages.
    expect(calibration.sensitivityVerdict.carriedByLowConfidence).toEqual([
      "cancellation-account-page-no-path-en",
      "cancellation-account-page-no-path-ja",
      "scarcity-countdown-timer-en",
    ]);
    const named = new Set(calibration.sensitivityVerdict.carriedByLowConfidence);
    for (const entry of calibration.cases) {
      expect(entry.lowConfidenceOnly === true, entry.id).toBe(named.has(entry.id));
    }
  });

  it("does not claim the severity ladder is evidenced when every clean page scores zero", () => {
    // The trap this closes: six variants separating reads as robustness. It is not — while no clean
    // page scores at all, any non-negative weighting separates, so the table says nothing about the
    // ratios between high, medium, low, and info.
    expect(calibration.sensitivityVerdict.cleanPagesAllZero).toBe(true);
    expect(calibration.sensitivityVerdict.severityWeightsAreLoadBearing).toBe(false);
  });

  it("states how many pages it was calibrated against, and gets the number right", () => {
    // It said 26 for long enough that the corpus grew to 33 underneath it, and the artifact
    // disagreed with its own separation counts in the same file.
    const pages = calibration.separation.problemPages + calibration.separation.cleanPages;
    expect(pages).toBe(manifest.cases.length);
    expect(calibration.disclaimer).toContain(`${pages} pages`);
  });

  it("is the version the model claims", () => {
    expect(calibration.modelVersion).toBe("fairux-risk/1");
  });
});

/**
 * Collections exist to make one sentence in the model's limitations checkable: the worst-input
 * aggregation cannot see breadth. They introduce no new pages, because a collection that brought its
 * own would be measuring the pages rather than the aggregation.
 */
describe("the corpus collections", () => {
  it("names only cases the manifest already labels", () => {
    const known = new Set(manifest.cases.map((entry) => entry.id));
    for (const collection of manifest.collections) {
      expect(collection.caseIds.length).toBeGreaterThan(0);
      for (const caseId of collection.caseIds) {
        expect(known.has(caseId), `${collection.id} → ${caseId}`).toBe(true);
      }
    }
  });

  it("gives every collection a unique id, a known kind, and a summary", () => {
    const ids = manifest.collections.map((collection) => collection.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const collection of manifest.collections) {
      expect(["multi-input", "journey"]).toContain(collection.kind);
      expect(collection.summary.trim().length).toBeGreaterThan(20);
    }
  });

  it("keeps the three collections the breadth question is asked with", () => {
    // Remove any of these and the aggregation table below stops being able to fail.
    const ids = new Set(manifest.collections.map((collection) => collection.id));
    expect(ids.has("breadth-one-problem-page")).toBe(true);
    expect(ids.has("breadth-problem-page-repeated")).toBe(true);
    expect(ids.has("breadth-problem-page-among-clean")).toBe(true);
  });
});

const aggregation = (
  calibration as unknown as {
    readonly aggregation: {
      readonly shipped: string;
      readonly candidates: readonly {
        readonly id: string;
        readonly seesBreadth: boolean;
        readonly punishesCoverage: boolean;
      }[];
      readonly collections: readonly {
        readonly id: string;
        readonly crossStepFindings: number;
        readonly scores: Record<string, number>;
      }[];
    };
  }
).aggregation;

describe("the measured aggregation candidates", () => {
  it("records that the shipped one cannot see breadth, rather than asserting it in prose", () => {
    const shipped = aggregation.candidates.find(
      (candidate) => candidate.id === aggregation.shipped,
    );
    expect(shipped?.seesBreadth).toBe(false);
    expect(shipped?.punishesCoverage).toBe(false);
    const alone = aggregation.collections.find((entry) => entry.id === "breadth-one-problem-page")
      ?.scores[aggregation.shipped];
    const repeated = aggregation.collections.find(
      (entry) => entry.id === "breadth-problem-page-repeated",
    )?.scores[aggregation.shipped];
    expect(repeated).toBe(alone);
  });

  it("has at least one candidate of each verdict, so the table can distinguish them", () => {
    // A comparison where every row agrees is a comparison that would look identical if it were
    // broken. Both columns have to be able to say either thing.
    expect(aggregation.candidates.some((candidate) => candidate.seesBreadth)).toBe(true);
    expect(aggregation.candidates.some((candidate) => candidate.punishesCoverage)).toBe(true);
    expect(aggregation.candidates.some((candidate) => !candidate.punishesCoverage)).toBe(true);
  });

  it("shows every journey scoring from its steps alone, because no journey rule exists", () => {
    const journeys = aggregation.collections.filter((entry) => entry.id.startsWith("journey-"));
    expect(journeys.length).toBeGreaterThan(0);
    for (const journey of journeys) expect(journey.crossStepFindings).toBe(0);
  });
});

const secondModel = (
  calibration as unknown as {
    readonly secondModel: {
      readonly modelVersion: string;
      readonly default: boolean;
      readonly agreesWithV1OnSinglePages: boolean;
      readonly separation: { readonly separated: boolean; readonly margin: number };
    };
  }
).secondModel;

describe("fairux-risk/2, as the calibration recorded it", () => {
  it("bought breadth without giving up separation", () => {
    expect(secondModel.modelVersion).toBe("fairux-risk/2");
    expect(secondModel.separation.separated).toBe(true);
    expect(secondModel.separation.margin).toBeGreaterThan(0);
  });

  it("agrees with fairux-risk/1 on every single-page case", () => {
    // The corpus is single pages, so this is the whole corpus. A difference would mean the breadth
    // term contributed something where there is nothing to aggregate.
    expect(secondModel.agreesWithV1OnSinglePages).toBe(true);
    expect(secondModel.separation.margin).toBe(calibration.separation.margin);
  });

  it("is not the default, and the artifact says so", () => {
    // Two scores are comparable when their model versions match. Moving the default changes what
    // every number written before it meant, which is a maintainer's decision.
    expect(secondModel.default).toBe(false);
  });
});

const journeyScoring = (
  calibration as unknown as {
    readonly journeyScoring: {
      readonly stepsOnly: { readonly score: number; readonly crossStepFindings: number };
      readonly anchoredToQuietStep: { readonly score: number };
      readonly anchoredToWorstStep: { readonly score: number };
      readonly anchoringChangesScore: boolean;
      readonly crossStepFindingIgnoredOnAQuietStep: boolean;
      readonly worthOnTheWorstStep: number;
      readonly modelRequiresJourneyCapability: boolean;
    };
  }
).journeyScoring;

/**
 * The three questions #135 asked before the first journey rule exists, now measured.
 *
 * Pinned rather than described: two of the answers are "no, and that is fine", and the third is a
 * defect. A defect recorded only in prose is one nobody notices has been fixed or made worse.
 */
describe("how a journey scores", () => {
  it("weighs a cross-step finding exactly like a page finding", () => {
    // A medium at high confidence contributes 10 either way. Crossing a boundary changes no weight.
    expect(journeyScoring.worthOnTheWorstStep).toBe(10);
  });

  it("gates a flow the way it gates a page, and not more", () => {
    expect(journeyScoring.modelRequiresJourneyCapability).toBe(false);
  });

  it("lets anchoring decide the number, which is the answer that matters", () => {
    expect(journeyScoring.anchoringChangesScore).toBe(true);
    expect(journeyScoring.anchoredToWorstStep.score).toBeGreaterThan(
      journeyScoring.anchoredToQuietStep.score,
    );
  });

  it("drops a cross-step finding entirely when it is anchored to a quiet step", () => {
    // `stepId` is where a reader should look; the aggregation reads it as which input the finding
    // belongs to. A rule anchoring to where the problem becomes visible can score zero for it.
    expect(journeyScoring.crossStepFindingIgnoredOnAQuietStep).toBe(true);
    expect(journeyScoring.anchoredToQuietStep.score).toBe(journeyScoring.stepsOnly.score);
  });

  it("measures a flow that has no cross-step findings of its own, like every real one", () => {
    expect(journeyScoring.stepsOnly.crossStepFindings).toBe(0);
  });
});
