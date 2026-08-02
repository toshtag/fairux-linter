import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
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
    readonly undetectedProblemPages: readonly string[];
    readonly detectedProblemPages: number;
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

  it("scores every clean page at zero", () => {
    for (const entry of calibration.cases) {
      if (entry.kind === "negative") expect(entry.score).toBe(0);
    }
  });

  it("names the pages it is silent about rather than averaging them away", () => {
    // A page whose problem was never detected scores zero, and no weights can rank it above a clean
    // page. That is a recall failure — it belongs to the corpus evaluation, and is listed here so a
    // reader knows the index says nothing about it.
    expect(calibration.separation.undetectedProblemPages).toEqual([
      "obstruction-confirmshaming-decline-en",
    ]);
    expect(calibration.separation.detectedProblemPages).toBe(13);
  });

  it("records which weight changes break the separation", () => {
    const broken = calibration.sensitivity
      .filter((variant) => !variant.separation.separated)
      .map((variant) => variant.variant);
    // The useful result: the severity ladder is not load-bearing on this corpus, and the confidence
    // floor is. That is the argument for 0.3 rather than 0, and it is measured rather than asserted.
    expect(broken).toEqual(["low confidence dropped", "confidence dominant"]);
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
