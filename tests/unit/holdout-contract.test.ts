import { describe, expect, it } from "vitest";
import {
  canonicalJson,
  coverageRefusals,
  EVIDENCE_CLASSES,
  HOLDOUT_SCHEMA_VERSION,
  MIN_LOWER_BOUND_AT_PERFECT,
  manifestRefusals,
  minimumSamples,
  REQUIRED_RUNTIMES,
  requiredStrata,
  sealDigest,
  summarise,
  wilsonInterval,
  // @ts-expect-error — the contract module is plain JS, like every other one here.
} from "../../scripts/holdout-contract.mjs";

/**
 * `P7`'s four conditions, as arithmetic and as refusals.
 *
 * The criterion exists because a number from pages nobody here wrote is not automatically evidence,
 * and the conditions were written down before there was a number to argue about. This file is where
 * they stop being prose: every one of them is a case, and every case is the failure it prevents
 * rather than a unit test of a helper.
 */

interface Interval {
  readonly point: number;
  readonly lower: number;
  readonly upper: number;
  readonly trials: number;
}
const interval = (successes: number, trials: number): Interval | null =>
  wilsonInterval(successes, trials) as Interval | null;

const VOCABULARY = {
  locales: ["en", "ja"],
  ruleIds: ["consent/checked-checkbox", "scarcity/scarcity-phrase"],
};

interface Sample {
  id: string;
  file: string;
  locale: string;
  runtime: string;
  summary: string;
  expected: { ruleId: string; count: number }[];
  negativeFor: string[];
}

function sample(overrides: Partial<Sample> = {}): Sample {
  return {
    id: "a",
    file: "pages/a.html",
    locale: "en",
    runtime: "html",
    summary: "a page",
    expected: [],
    negativeFor: [],
    ...overrides,
  };
}

function manifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: HOLDOUT_SCHEMA_VERSION,
    evidenceClass: EVIDENCE_CLASSES.EXTERNAL,
    packageId: "p",
    preparedBy: "someone else",
    preparedAt: "2026-08-08",
    seal: { algorithm: "sha256", digest: "a".repeat(64) },
    samples: [sample()],
    ...overrides,
  };
}

const refusals = (value: unknown): string[] =>
  manifestRefusals(value, VOCABULARY) as unknown as string[];

describe("the uncertainty a first score has to carry", () => {
  it("reports nothing rather than zero when there was nothing to measure", () => {
    // "Recall 0.000" from no labelled positives is a claim nobody made. A dash is the honest answer.
    expect(interval(0, 0)).toBeNull();
  });

  it("keeps width at the extremes, which is why it is Wilson and not the normal approximation", () => {
    // The normal interval is p̂ ± z·√(p̂(1−p̂)/n), which is exactly zero wide when p̂ is 0 or 1 —
    // certainty from nine samples. That is the number that gets quoted.
    const perfect = interval(9, 9);
    expect(perfect?.upper).toBe(1);
    expect(perfect?.lower).toBeLessThan(1);
    const hopeless = interval(0, 9);
    expect(hopeless?.lower).toBe(0);
    expect(hopeless?.upper).toBeGreaterThan(0);
  });

  it("carries the count, because the same rate over 40 and over 400 are different claims", () => {
    expect(interval(8, 10)?.trials).toBe(10);
    const wide = interval(8, 10);
    const narrow = interval(80, 100);
    expect(wide && narrow && narrow.upper - narrow.lower).toBeLessThan(
      (wide?.upper ?? 0) - (wide?.lower ?? 0),
    );
  });
});

describe("the per-rule minimum, and where it comes from", () => {
  const minimum = minimumSamples() as number;

  it("is derived from the threshold rather than written down beside it", () => {
    // The whole point of deriving it: the constant somebody argues with is the bound, and the
    // number of pages an external preparer has to assemble follows from it. If this held for one
    // fewer sample, the constant would be doing nothing.
    expect(interval(minimum, minimum)?.lower).toBeGreaterThanOrEqual(MIN_LOWER_BOUND_AT_PERFECT);
    expect(interval(minimum - 1, minimum - 1)?.lower).toBeLessThan(MIN_LOWER_BOUND_AT_PERFECT);
  });

  it("refuses a package that is under it, in either direction, per rule", () => {
    const under = manifest({
      samples: [
        sample({ id: "p", expected: [{ ruleId: "consent/checked-checkbox", count: 1 }] }),
        sample({ id: "n", negativeFor: ["consent/checked-checkbox"] }),
      ],
    });
    const found = coverageRefusals(under, VOCABULARY) as unknown as string[];
    expect(found.some((line) => line.includes("1 positive sample"))).toBe(true);
    expect(found.some((line) => line.includes("1 declared near miss"))).toBe(true);
  });

  it("does not count incidental silence as a near miss", () => {
    // The condition that is easiest to lose: a package could otherwise satisfy every negative
    // minimum by containing unrelated pages, and a page about train timetables says nothing about
    // a consent rule's false-positive rate.
    const unrelated = Array.from({ length: minimum * 2 }, (_, index) =>
      sample({ id: `unrelated-${index}` }),
    );
    const found = coverageRefusals(manifest({ samples: unrelated }), VOCABULARY) as string[];
    expect(found.some((line) => line.includes("0 declared near miss"))).toBe(true);
  });
});

describe("stratification, which a pooled score would hide", () => {
  const minimum = minimumSamples() as number;
  const STRATA = requiredStrata(VOCABULARY.locales) as { locale: string; runtime: string }[];

  /**
   * A package that clears every minimum, built so a single case can take one thing away.
   *
   * `minimum` samples in each of the six strata, with rule labels spread across them so both rules
   * reach their positive and negative minimums globally. That is what the contract asks for — the
   * per-rule minimums are over the whole package, and the stratum minimum is about the stratum's
   * own row. Requiring the first *inside* the second would be rules × locales × runtimes × 2 ×
   * `minimum` labelled samples, which is not the criterion and is not a package anyone assembles.
   */
  function complete(drop?: { locale: string; runtime: string }): Record<string, unknown> {
    const samples: Sample[] = [];
    for (const stratum of STRATA) {
      if (drop && stratum.locale === drop.locale && stratum.runtime === drop.runtime) continue;
      for (let index = 0; index < minimum; index += 1) {
        const positive = VOCABULARY.ruleIds[index % 2] as string;
        const negative = VOCABULARY.ruleIds[(index + 1) % 2] as string;
        samples.push(
          sample({
            id: `${stratum.locale}-${stratum.runtime}-${index}`,
            locale: stratum.locale,
            runtime: stratum.runtime,
            expected: index < 6 ? [{ ruleId: positive, count: 1 }] : [],
            negativeFor: index >= 3 ? [negative] : [],
          }),
        );
      }
    }
    return manifest({ samples });
  }

  it("accepts a package that covers every stratum and clears every minimum", () => {
    // The negative control. Every refusal below would look the same if this function always
    // returned something.
    expect(coverageRefusals(complete(), VOCABULARY)).toEqual([]);
  });

  it("refuses an empty stratum even when every locale and every runtime appears elsewhere", () => {
    // The defect this contract was rewritten for. Asking for each locale *somewhere* and each
    // runtime *somewhere* is satisfied by a package with no `ja/figma` page at all, while every
    // report goes on saying "per stratum".
    const found = coverageRefusals(
      complete({ locale: "ja", runtime: "figma" }),
      VOCABULARY,
    ) as string[];
    expect(found).toHaveLength(1);
    expect(found[0]).toContain("ja/figma: 0 sample(s)");
    // And the locales and runtimes it dropped are all still present in other strata, which is what
    // makes this the case the old contract could not see.
    const samples = (complete({ locale: "ja", runtime: "figma" }).samples ?? []) as Sample[];
    expect(samples.some((entry) => entry.locale === "ja")).toBe(true);
    expect(samples.some((entry) => entry.runtime === "figma")).toBe(true);
  });

  it("refuses a stratum that is present but too small to carry a rate", () => {
    const thin = complete().samples as Sample[];
    const trimmed = thin.filter(
      (entry) => !(entry.locale === "en" && entry.runtime === "ast") || entry.id.endsWith("-0"),
    );
    const found = coverageRefusals(manifest({ samples: trimmed }), VOCABULARY) as string[];
    expect(found.some((line) => line.startsWith(`en/ast: 1 sample(s), and ${minimum}`))).toBe(true);
  });

  it("asks for the cross product, derived from the dictionaries that ship", () => {
    expect(STRATA.map((entry) => `${entry.locale}/${entry.runtime}`).sort()).toEqual([
      "en/ast",
      "en/figma",
      "en/html",
      "ja/ast",
      "ja/figma",
      "ja/html",
    ]);
    // A holdout is files. `dom` is the live-DOM adapter and would be a stratum nobody could supply
    // a sample for.
    expect([...(REQUIRED_RUNTIMES as string[])].sort()).toEqual(["ast", "figma", "html"]);
  });

  it("does not multiply the per-rule minimum by the strata", () => {
    // The overstatement worth pinning: a complete package is `minimum` per stratum, not `minimum`
    // per rule per direction per stratum. If this contract ever grew into the product, the number
    // of labelled samples an external preparer needs would jump by more than an order of magnitude
    // — so the cheapest guard is to state the size the contract actually accepts.
    const samples = (complete().samples ?? []) as Sample[];
    expect(samples).toHaveLength(minimum * STRATA.length);
    expect(coverageRefusals(manifest({ samples }), VOCABULARY)).toEqual([]);
  });
});

describe("what a manifest has to say before anything is scored", () => {
  it("accepts the well-formed one, so the cases below mean something", () => {
    expect(refusals(manifest())).toEqual([]);
  });

  it("refuses a package that does not say what its numbers may be used for", () => {
    // The field exists because this harness needs tests, and a synthetic package is written by the
    // same people who wrote the rules. Required rather than defaulted: the permissive value must
    // never be what an omission means.
    expect(refusals(manifest({ evidenceClass: undefined })).join()).toContain("evidenceClass");
    expect(refusals(manifest({ evidenceClass: "trust-me" })).join()).toContain("evidenceClass");
  });

  it("refuses a schema version it does not read", () => {
    expect(refusals(manifest({ schemaVersion: 2 })).join()).toContain("schemaVersion");
  });

  it("refuses an unsealed package", () => {
    expect(refusals(manifest({ seal: undefined })).join()).toContain("seal");
    expect(
      refusals(manifest({ seal: { algorithm: "md5", digest: "a".repeat(64) } })).join(),
    ).toContain("seal");
  });

  it("refuses a sample file that reaches outside the package", () => {
    // The manifest is written by somebody outside this repository and names files this process
    // opens. The refusal has to come before the read, not after resolving and comparing.
    for (const file of ["../../etc/passwd", "/etc/passwd", "pages/../../secrets"]) {
      expect(refusals(manifest({ samples: [sample({ file })] })).join(), file).toContain(
        "relative path inside the package",
      );
    }
  });

  it("refuses a label naming a rule or a locale that does not exist", () => {
    expect(
      refusals(
        manifest({ samples: [sample({ expected: [{ ruleId: "made/up", count: 1 }] })] }),
      ).join(),
    ).toContain("which is not a rule");
    expect(refusals(manifest({ samples: [sample({ locale: "de" })] })).join()).toContain(
      "is not one this rule set ships",
    );
  });

  it("refuses a sample that is both a positive and a near miss for one rule", () => {
    const both = sample({
      expected: [{ ruleId: "consent/checked-checkbox", count: 1 }],
      negativeFor: ["consent/checked-checkbox"],
    });
    expect(refusals(manifest({ samples: [both] })).join()).toContain(
      "both expected and declared a near miss",
    );
  });

  it("reports every problem rather than the first", () => {
    // A preparer fixing a package one refusal per run is a preparer who stops.
    const broken = manifest({ schemaVersion: 9, evidenceClass: "x", packageId: "" });
    expect(refusals(broken).length).toBeGreaterThan(2);
  });
});

describe("the seal, which is what immutability rests on", () => {
  const contents = () => new Map([["a", "<p>one</p>"]]);

  it("changes when a page changes", () => {
    const before = sealDigest(manifest(), contents());
    expect(sealDigest(manifest(), new Map([["a", "<p>two</p>"]]))).not.toBe(before);
  });

  it("changes when a label changes, which is the edit that leaves no other trace", () => {
    // A digest over the files alone would let a disappointing result be relabelled afterwards. That
    // is the third condition's actual failure mode, and it is invisible in the pages.
    const before = sealDigest(manifest(), contents());
    const relabelled = manifest({
      samples: [sample({ expected: [{ ruleId: "consent/checked-checkbox", count: 1 }] })],
    });
    expect(sealDigest(relabelled, contents())).not.toBe(before);
  });

  it("does not change when the manifest is rewritten with its keys in another order", () => {
    // Otherwise re-serialising a manifest would look identical to editing one, and a preparer would
    // learn to re-seal without reading why the digest moved.
    const original = manifest() as Record<string, Record<string, unknown>[]> &
      Record<string, unknown>;
    const reverse = (value: object) => Object.fromEntries(Object.entries(value).reverse());
    const reordered = {
      ...reverse(original),
      seal: reverse(original.seal as object),
      samples: (original.samples as object[]).map(reverse),
    };
    expect(Object.keys(reordered)).not.toEqual(Object.keys(original));
    expect(sealDigest(reordered, contents())).toBe(sealDigest(original, contents()));
  });

  it("does not depend on the seal it is being compared with", () => {
    const other = manifest({ seal: { algorithm: "sha256", digest: "b".repeat(64) } });
    expect(sealDigest(other, contents())).toBe(sealDigest(manifest(), contents()));
  });

  it("sorts object keys at every depth", () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: [3, { f: 4, e: 5 }] } })).toBe(
      '{"a":{"c":[3,{"e":5,"f":4}],"d":2},"b":1}',
    );
  });
});

describe("what the numbers count", () => {
  const ruleIds = ["r/one", "r/two"];
  const scored = [
    {
      id: "positive",
      locale: "en",
      runtime: "html",
      expected: [{ ruleId: "r/one", count: 2 }],
      negativeFor: [],
      truePositives: [{ ruleId: "r/one", count: 1 }],
      falsePositives: [],
      falseNegatives: [{ ruleId: "r/one", count: 1 }],
    },
    {
      id: "near-miss",
      locale: "ja",
      runtime: "ast",
      expected: [],
      negativeFor: ["r/one", "r/two"],
      truePositives: [],
      falsePositives: [{ ruleId: "r/two", count: 1 }],
      falseNegatives: [],
    },
  ];

  interface Row {
    ruleId: string;
    truePositives: number;
    falsePositives: number;
    falseNegatives: number;
    trueNegatives: number;
    negativeSamples: number;
    specificity: Interval | null;
  }
  const STRATA = [
    { locale: "en", runtime: "html" },
    { locale: "ja", runtime: "ast" },
    { locale: "ja", runtime: "figma" },
  ];
  const result = summarise(scored, ruleIds, STRATA) as unknown as {
    totals: { samples: number; trueNegatives: number };
    byRule: Row[];
    byStratum: { locale: string; runtime: string; samples: number; belowMinimum: boolean }[];
  };
  const row = (ruleId: string) => result.byRule.find((entry) => entry.ruleId === ruleId);

  it("counts a rule that stayed quiet on a declared near miss as a true negative", () => {
    expect(row("r/one")?.trueNegatives).toBe(1);
  });

  it("does not count one that fired there", () => {
    // And the same event is the false positive, read from one run rather than from two definitions.
    expect(row("r/two")?.trueNegatives).toBe(0);
    expect(row("r/two")?.falsePositives).toBe(1);
    expect(row("r/two")?.specificity?.point).toBe(0);
    expect(row("r/two")?.specificity?.trials).toBe(1);
  });

  it("counts occurrences for precision and recall, matching the corpus evaluation", () => {
    // A rule labelled twice that fired once is one true positive and one miss, not a page that
    // half-passed. The two evaluations are only comparable if they count the same thing.
    expect(row("r/one")?.truePositives).toBe(1);
    expect(row("r/one")?.falseNegatives).toBe(1);
  });

  it("gives every stable rule a row, including one nothing exercised", () => {
    expect(result.byRule.map((entry) => entry.ruleId)).toEqual(ruleIds);
  });

  it("reports per stratum rather than pooled", () => {
    expect(result.byStratum.map((entry) => `${entry.locale}/${entry.runtime}`)).toEqual([
      "en/html",
      "ja/ast",
      "ja/figma",
    ]);
  });

  it("gives a stratum with no samples a row reading zero", () => {
    // Without this, "reported per stratum" would be true of whatever happened to be in the package
    // — the stratum a reader most needs to see is the one nobody sampled.
    const empty = result.byStratum.find((entry) => entry.runtime === "figma");
    expect(empty?.samples).toBe(0);
    expect(empty?.belowMinimum).toBe(true);
  });

  it("marks every stratum that cannot carry a rate of its own", () => {
    expect(result.byStratum.every((entry) => entry.belowMinimum)).toBe(true);
  });
});
