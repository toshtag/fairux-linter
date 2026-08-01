import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  alertIdentityAcrossMove,
  assertCanaryRef,
  assertCommitSha,
  CANARY_CATEGORIES,
  CANARY_CATEGORY_LIST,
  CANARY_TOOL_NAME,
  logicalOnlyAlertShape,
  partitionCanaryAnalyses,
  prepareCanarySarif,
  undeletableAnalysisSet,
} from "../../scripts/sarif-canary-contract.mjs";

/**
 * The SARIF canary's refusals, checked without a network call.
 *
 * It uploads real analyses to real code scanning and then deletes them. An upload aimed at the
 * wrong ref writes into the default branch's alert set; a delete aimed at the wrong analysis
 * destroys someone else's evidence. Neither is recoverable by rerunning, and neither would be
 * caught by a green canary run — the run that did the damage would report success.
 */

const REF = "refs/heads/fairux-sarif-canary-1ba1710";
const SHA = "a".repeat(40);

describe("the only ref the canary may write to", () => {
  it("accepts the canary's own branch", () => {
    expect(assertCanaryRef(REF, { defaultBranch: "main" })).toBe(REF);
    expect(
      assertCanaryRef(`refs/heads/fairux-sarif-canary-${"b".repeat(40)}`, {
        defaultBranch: "main",
      }),
    ).toBeTruthy();
  });

  it("refuses the default branch, a tag, a pull request ref, and a near miss", () => {
    for (const ref of [
      "refs/heads/main",
      "refs/tags/v1.0.0",
      "refs/pull/42/head",
      "refs/heads/fairux-sarif-canary",
      "refs/heads/fairux-sarif-canary-",
      "refs/heads/fairux-sarif-canary-ZZZZZZZ",
      "refs/heads/x-fairux-sarif-canary-1ba1710",
      "fairux-sarif-canary-1ba1710",
      undefined,
      42,
    ]) {
      expect(() => assertCanaryRef(ref, { defaultBranch: "main" }), String(ref)).toThrow();
    }
  });

  it("refuses a default branch that happens to match the pattern", () => {
    // Not redundant with the pattern check. A repository whose default branch was renamed to the
    // canary's shape would otherwise pass, and the consequence is canary alerts in the view the
    // Security tab shows by default plus a cleanup that deletes real analyses.
    expect(() => assertCanaryRef(REF, { defaultBranch: "fairux-sarif-canary-1ba1710" })).toThrow(
      /default branch/,
    );
  });
});

describe("the commits the canary may name", () => {
  it("accepts a full SHA", () => {
    expect(assertCommitSha(SHA, "--sha")).toBe(SHA);
  });

  it("refuses an abbreviation, a branch name, and the wrong case", () => {
    // Parts of GitHub's API accept an abbreviated SHA or a ref here, and either would make the
    // analysis point somewhere other than where the recorded evidence says it does.
    for (const sha of ["1ba1710", "main", "HEAD", `${"A".repeat(40)}`, "", undefined]) {
      expect(() => assertCommitSha(sha, "--sha"), String(sha)).toThrow();
    }
  });
});

describe("the category an upload carries", () => {
  it("sets automationDetails.id, which is what GitHub reads as the category", () => {
    const prepared = prepareCanarySarif(
      { version: "2.1.0", runs: [{ tool: {}, results: [{ ruleId: "r" }] }] },
      { category: CANARY_CATEGORIES.physical },
    );
    // With the trailing slash GitHub's SARIF support documents. Without it the first canary run's
    // four distinct ids all came back as `category: ""`, so the separation never happened.
    expect(prepared.runs[0]?.automationDetails).toEqual({ id: `${CANARY_CATEGORIES.physical}/` });
    expect(prepared.runs[0]?.results).toHaveLength(1);
  });

  it("clears the results for the stage that asks whether an alert closes", () => {
    const prepared = prepareCanarySarif(
      { version: "2.1.0", runs: [{ tool: {}, results: [{ ruleId: "r" }] }] },
      { category: CANARY_CATEGORIES.physical, empty: true },
    );
    expect(prepared.runs[0]?.results).toEqual([]);
  });

  it("does not mutate the input", () => {
    const input = { version: "2.1.0", runs: [{ tool: {}, results: [{ ruleId: "r" }] }] };
    prepareCanarySarif(input, { category: CANARY_CATEGORIES.logical, empty: true });
    expect(input.runs[0]?.results).toHaveLength(1);
    expect(input.runs[0]).not.toHaveProperty("automationDetails");
  });

  it("refuses a category this canary does not own", () => {
    for (const category of ["", "fairux", "fairux-sarif-canary-v1", "/", "default"]) {
      expect(
        () => prepareCanarySarif({ runs: [{ results: [] }] }, { category }),
        category,
      ).toThrow();
    }
  });

  it("refuses a SARIF that is not exactly one run", () => {
    // Two runs in one upload become two analyses with the same category, which GitHub rejects as
    // duplicate automation details — and a zero-run log would upload nothing while reporting a
    // successful stage.
    for (const runs of [[], [{}, {}], undefined]) {
      expect(
        () => prepareCanarySarif({ runs }, { category: CANARY_CATEGORIES.physical }),
        JSON.stringify(runs),
      ).toThrow();
    }
  });

  it("keeps every probe in its own versioned category", () => {
    // One shared category would have each upload replacing the previous analysis and closing its
    // alert — which is exactly the signal stage C produces deliberately, and would be
    // indistinguishable from it.
    expect(new Set(CANARY_CATEGORY_LIST).size).toBe(CANARY_CATEGORY_LIST.length);
    expect(CANARY_CATEGORY_LIST).toEqual(Object.values(CANARY_CATEGORIES));
    for (const category of CANARY_CATEGORY_LIST) {
      expect(category).toMatch(/^fairux-sarif-canary-v1-/);
    }
  });
});

describe("the location shapes the canary probes", () => {
  /**
   * GitHub refused the reporter's own shape outright — `locationFromSarifResult: expected a
   * physical location`, failing the whole submission rather than skipping the one result
   * ([#90](https://github.com/toshtag/fairux-linter/issues/90)). These are the two candidate fixes.
   * Shaping them here rather than in the reporter is the point: a fix chosen without measuring is a
   * guess, and inventing a source line for a Figma node is the dishonesty the reporter avoids.
   */
  const logicalResult = {
    ruleId: "consent/checked-checkbox",
    locations: [{ logicalLocations: [{ name: "1:1", kind: "figma" }] }],
    properties: { fairux: { category: "consent" } },
  };
  const log = () => ({ version: "2.1.0", runs: [{ tool: {}, results: [logicalResult] }] });

  it("leaves the emitted shape alone by default", () => {
    const prepared = prepareCanarySarif(log(), { category: CANARY_CATEGORIES.logical });
    expect(prepared.runs[0]?.results[0]).toEqual(logicalResult);
  });

  it("drops the locations key entirely, which SARIF permits", () => {
    const result = prepareCanarySarif(log(), {
      category: CANARY_CATEGORIES.logicalNoLocations,
      locationShape: "none",
    }).runs[0]?.results[0] as Record<string, unknown>;
    expect(result).not.toHaveProperty("locations");
    // Kept, not discarded: what the reporter said is part of what the probe is comparing.
    expect(result.properties).toMatchObject({
      fairuxCanaryOriginalLocations: logicalResult.locations,
    });
  });

  it("points at the scanned file itself, with no invented line", () => {
    const result = prepareCanarySarif(log(), {
      category: CANARY_CATEGORIES.logicalInputFile,
      locationShape: "input-file",
      artifactUri: "tests/fixtures/sarif-canary/design.figjson",
    }).runs[0]?.results[0] as Record<string, unknown>;
    expect(result.locations).toEqual([
      {
        physicalLocation: {
          artifactLocation: { uri: "tests/fixtures/sarif-canary/design.figjson" },
        },
      },
    ]);
    // No `region`. A Figma node has no line, and a fabricated one would be worse than none.
    expect(JSON.stringify(result.locations)).not.toContain("region");
  });

  it("refuses the input-file shape without a file to name", () => {
    expect(() =>
      prepareCanarySarif(log(), {
        category: CANARY_CATEGORIES.logicalInputFile,
        locationShape: "input-file",
      }),
    ).toThrow(/artifactUri/);
  });
});

describe("what cleanup is allowed to delete", () => {
  const canary = (overrides = {}) => ({
    id: 1,
    ref: REF,
    category: CANARY_CATEGORIES.physical,
    tool: { name: CANARY_TOOL_NAME },
    ...overrides,
  });

  it("selects analyses on the canary's own ref, whatever category GitHub reports", () => {
    // Measured, not designed: GitHub returned `category: ""` for every analysis the first run
    // created. A category-keyed matcher recognised none of its own uploads, so the ref — unique per
    // run, refused by `assertCanaryRef` for anything else — is what ownership actually rests on.
    const { targets, foreign } = partitionCanaryAnalyses(
      [canary({ id: 1, category: "" }), canary({ id: 2, category: undefined })],
      { ref: REF, tool: CANARY_TOOL_NAME, categories: CANARY_CATEGORY_LIST },
    );
    expect(targets.map((a) => a.id)).toEqual([1, 2]);
    expect(foreign).toHaveLength(0);
  });

  it("selects only analyses matching the ref, tool, and one of the canary's categories", () => {
    const { targets, foreign } = partitionCanaryAnalyses(
      [
        canary({ id: 1 }),
        canary({ id: 2, category: CANARY_CATEGORIES.logical }),
        canary({ id: 3, ref: "refs/heads/main" }),
        canary({ id: 4, tool: { name: "CodeQL" } }),
        canary({ id: 5, category: "default" }),
        canary({ id: undefined }),
      ],
      { ref: REF, tool: CANARY_TOOL_NAME, categories: CANARY_CATEGORY_LIST },
    );
    expect(targets.map((a) => a.id)).toEqual([1, 2]);
    expect(foreign).toHaveLength(4);
  });

  it("never folds a longer category into a shorter one", () => {
    // `fairux-sarif-canary-v1-physical-extra` starts with a category this canary owns. A prefix or
    // substring match would delete it, and a delete is not the place to find that out.
    const { targets, foreign } = partitionCanaryAnalyses(
      [canary({ category: `${CANARY_CATEGORIES.physical}-extra` })],
      { ref: REF, tool: CANARY_TOOL_NAME, categories: CANARY_CATEGORY_LIST },
    );
    expect(targets).toHaveLength(0);
    expect(foreign).toHaveLength(1);
  });

  it("refuses to delete when the listing contains anything else", () => {
    const partition = partitionCanaryAnalyses([canary(), canary({ id: 9, category: "default" })], {
      ref: REF,
      tool: CANARY_TOOL_NAME,
      categories: CANARY_CATEGORY_LIST,
    });
    expect(undeletableAnalysisSet(partition, { ref: REF })).toMatch(/refusing to delete/);
  });

  it("permits an empty target set, so a rerun after a clean run is not a failure", () => {
    // Treating "nothing to delete" as an error would teach the owner to ignore this exit code.
    expect(undeletableAnalysisSet({ targets: [], foreign: [] }, { ref: REF })).toBeNull();
  });
});

describe("the observation the canary exists to produce", () => {
  const alert = (number: number, startLine: number, fingerprints?: Record<string, string>) => ({
    number,
    rule: { id: "consent/missing-reject-option" },
    state: "open",
    most_recent_instance: {
      location: { path: "tests/fixtures/sarif-canary/page.html", start_line: startLine },
      partial_fingerprints: fingerprints,
    },
  });

  it("reports a continuous alert number across the line move as continuity", () => {
    const observed = alertIdentityAcrossMove({ before: alert(7, 12), after: alert(7, 18) });
    expect(observed.sameAlertNumber).toBe(true);
    expect(observed.before?.startLine).toBe(12);
    expect(observed.after?.startLine).toBe(18);
  });

  it("reports a new alert number as a break", () => {
    expect(
      alertIdentityAcrossMove({ before: alert(7, 12), after: alert(8, 18) }).sameAlertNumber,
    ).toBe(false);
  });

  it("says it does not know when either side is missing", () => {
    // A missing alert is not the same as a broken identity, and recording it as `false` would be
    // recording a conclusion the canary did not observe.
    expect(
      alertIdentityAcrossMove({ before: alert(7, 12), after: undefined }).sameAlertNumber,
    ).toBeNull();
    expect(
      alertIdentityAcrossMove({ before: undefined, after: undefined }).sameAlertNumber,
    ).toBeNull();
  });

  it("never presents an absent fingerprint as proof that GitHub generated none", () => {
    // This is the claim #79 rests on. The alerts API may simply not expose the field, and reading
    // its absence as "GitHub generated nothing" would turn a gap in the API into a conclusion.
    const absent = alertIdentityAcrossMove({ before: alert(7, 12), after: alert(7, 18) });
    expect(absent.generatedFingerprint).toBeNull();
    expect(absent.note).toContain("not evidence");

    const present = alertIdentityAcrossMove({
      before: alert(7, 12),
      after: alert(7, 18, { primaryLocationLineHash: "deadbeef" }),
    });
    expect(present.generatedFingerprint).toBe("deadbeef");
    expect(present.note).toContain("GitHub reported");
  });

  it("records a logical-only alert's shape without inventing a location for it", () => {
    const shape = logicalOnlyAlertShape({
      number: 9,
      rule: { id: "consent/checked-checkbox" },
      state: "open",
      most_recent_instance: { location: {} },
    });
    expect(shape).toEqual({
      present: true,
      ruleId: "consent/checked-checkbox",
      path: null,
      startLine: null,
      state: "open",
    });
  });

  it("records an absent logical-only alert as absent", () => {
    expect(logicalOnlyAlertShape(undefined).present).toBe(false);
  });
});

describe("the canary fixtures", () => {
  const root = resolve(import.meta.dirname, "../..");
  const read = (name: string) =>
    readFileSync(resolve(root, "tests/fixtures/sarif-canary", name), "utf8");

  it("keeps the HTML fixture's finding on a line the move stage can shift", () => {
    // Stage B moves this line and nothing else. If the fixture ever stops producing exactly one
    // finding, the comparison would be between two different findings rather than one that moved.
    const html = read("page.html");
    expect(html).toContain(">Accept</button>");
    expect(html).toContain('aria-label="Close"');
  });

  it("keeps the Figma fixture free of any source location", () => {
    // The logical-only half. A `.figjson` has no lines a rule could point at, which is the whole
    // reason it is the fixture for that observation.
    const figma = JSON.parse(read("design.figjson"));
    expect(figma.document?.children?.[0]?.componentProperties).toBeDefined();
  });
});
