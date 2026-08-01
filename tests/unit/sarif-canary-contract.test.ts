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
    expect(prepared.runs[0]?.automationDetails).toEqual({ id: CANARY_CATEGORIES.physical });
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

  it("keeps the two categories separate and versioned", () => {
    // One category would have the Figma upload replacing the HTML analysis and closing its alert —
    // which is exactly the signal stage C produces deliberately, and would be indistinguishable.
    expect(CANARY_CATEGORIES.physical).not.toBe(CANARY_CATEGORIES.logical);
    expect(CANARY_CATEGORY_LIST).toEqual([CANARY_CATEGORIES.physical, CANARY_CATEGORIES.logical]);
    for (const category of CANARY_CATEGORY_LIST) {
      expect(category).toMatch(/^fairux-sarif-canary-v1-/);
    }
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
