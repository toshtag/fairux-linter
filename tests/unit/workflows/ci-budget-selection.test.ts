import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
// The production rules, not a copy. A test that re-implemented "which run is this tree's" would
// agree with itself while the checker picked something else — which is the exact shape of the bug
// this file exists to close.
import {
  type BudgetDecision,
  currentTreePullRequest,
  decideBudget,
  NO_CURRENT_TREE,
  runForHead,
} from "../../../scripts/ci-budget-contract.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const CHECKER = readFileSync(resolve(ROOT, "scripts/check-ci-budget.mjs"), "utf8");
const WORKFLOW = readFileSync(resolve(ROOT, ".github/workflows/release-contract.yml"), "utf8");

/**
 * Which run the budget's exemption is allowed to rest on.
 *
 * The budget does not fail on a median over budget when the lane has *since* been fixed — a ten-run
 * trailing median carries nine runs of a tree that no longer exists. The first version of that read
 * the current cost off the newest successful pull-request run in the repository, which is not this
 * tree: `release-contract.yml` runs on a push to `main`, and the newest pull-request run at that
 * moment belongs to whichever branch finished last.
 *
 * Wrong in both directions, and both are fixtures below: an unrelated *fast* run exempts a `main`
 * that really is over budget, and an unrelated *slow* run fails a `main` that has already been
 * fixed.
 *
 * Everything here is a pure function of fixture data. No network, no clock, no repository state.
 */

/**
 * Assert the verdict and narrow to it in one step.
 *
 * A cast on its own would let a case read `current.work` off a decision that never had one; an
 * `if` would let the assertion be skipped when the code is wrong, which is exactly when it matters.
 */
function expectCode<C extends BudgetDecision["code"]>(
  decision: BudgetDecision,
  code: C,
): Extract<BudgetDecision, { code: C }> {
  expect(decision.code).toBe(code);
  return decision as Extract<BudgetDecision, { code: C }>;
}

const BUDGET = 20;
const MERGED_HEAD = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const MAIN_SHA = "1111111111111111111111111111111111111111";
const UNRELATED_HEAD = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

/**
 * A run, carrying the work it measured.
 *
 * The work belongs to the run rather than being handed to the assertion separately, and that is
 * load-bearing: if a case says "the verdict does not depend on which run is newest" while the
 * number it judges is passed in by hand, the case is true and checks nothing. Selecting the wrong
 * run has to produce the wrong number, or none of this measures the selection.
 */
const run = (number: number, headSha: string, work: number, attempt = 1) => ({
  run_number: number,
  head_sha: headSha,
  run_attempt: attempt,
  work,
});

/** The pull request that produced `main`, as the commits/pulls endpoint reports it. */
const mergedPull = { number: 291, merged_at: "2026-08-06T13:43:49Z", head: { sha: MERGED_HEAD } };

/**
 * The window, newest first, with an unrelated run on top.
 *
 * This is the ordinary state on a push to `main`: the merge happened, and some other branch's run
 * finished afterwards. `samples[0]` is that other branch.
 */
const windowOf = (mergedWork: number, unrelatedWork: number) => [
  run(653, UNRELATED_HEAD, unrelatedWork),
  run(652, MERGED_HEAD, mergedWork),
  run(651, "cc", 30),
];

/**
 * What the checker does: find the pull request, find its head's run, take that run's work.
 *
 * The same two production functions the checker calls, in the same order, so a change to either is
 * a change to what these cases see.
 */
function currentTreeFor(runs: unknown, pulls: unknown) {
  const pull = currentTreePullRequest(pulls, MAIN_SHA);
  if (!pull.ok) return pull;
  const found = runForHead(runs, pull.headSha);
  if (!found.ok) return found;
  return {
    ok: true as const,
    work: found.run.work as number,
    label: `run ${found.run.run_number} (pull request #${pull.number})`,
  };
}

describe("the run the budget judges this tree by", () => {
  it("fails when the median and this tree's own run are both over, whatever finished later", () => {
    // Case 1. The unrelated newest run is comfortably inside the budget, and does not rescue this.
    const decision = decideBudget({
      median: 24,
      currentTree: currentTreeFor(windowOf(23, 15), [mergedPull]),
      budgetSeconds: BUDGET,
    });
    expect(decision.ok).toBe(false);
    expect(expectCode(decision, "over-budget").current.work).toBe(23);
  });

  it("passes as improving when this tree's own run is inside the budget", () => {
    // Case 2. The unrelated newest run is *over* budget, and does not fail an already-fixed main.
    const decision = decideBudget({
      median: 24,
      currentTree: currentTreeFor(windowOf(18, 23), [mergedPull]),
      budgetSeconds: BUDGET,
    });
    expect(decision.ok).toBe(true);
    expect(expectCode(decision, "improving").current.work).toBe(18);
  });

  it("fails, rather than borrowing a run, when no merged pull request claims the commit", () => {
    // Case 3. A direct push to `main`. There is no run for this tree, so there is no exemption —
    // and the newest unrelated run, however fast, is not a substitute.
    const decision = decideBudget({
      median: 24,
      currentTree: currentTreeFor(windowOf(18, 15), []),
      budgetSeconds: BUDGET,
    });
    expect(decision.ok).toBe(false);
    expect(expectCode(decision, "no-current-tree").refusal).toBe(NO_CURRENT_TREE.NO_PULL_REQUEST);
  });

  it("passes within budget whatever the current sample is, including none", () => {
    // Case 4. The exemption is only ever consulted when the median is over; below it there is
    // nothing to exempt, and a missing current-tree run must not turn a green lane red.
    for (const currentTree of [
      currentTreeFor(windowOf(19, 15), [mergedPull]),
      currentTreeFor(windowOf(99, 15), [mergedPull]),
      currentTreeFor(windowOf(19, 15), []),
      undefined,
    ]) {
      const decision = decideBudget({ median: 15, currentTree, budgetSeconds: BUDGET });
      expect(decision.ok).toBe(true);
      expect(decision.code).toBe("within-budget");
    }
  });

  it("is unmoved by one fast unrelated run arriving at the top of the window", () => {
    // Case 5. Same tree, same verdict, with and without somebody else's fast pull request. This
    // tree is over budget at 23s; the intruder measured 8s and must not rescue it.
    const without = [run(652, MERGED_HEAD, 23), run(651, "cc", 30)];
    const withFast = [run(653, UNRELATED_HEAD, 8), ...without];
    const verdict = (runs: unknown) =>
      decideBudget({
        median: 24,
        currentTree: currentTreeFor(runs, [mergedPull]),
        budgetSeconds: BUDGET,
      });
    expect(verdict(withFast).code).toBe(verdict(without).code);
    expect(expectCode(verdict(withFast), "over-budget").current.work).toBe(23);
  });

  it("is unmoved by one slow unrelated run arriving at the top of the window", () => {
    // Case 6. The mirror. This tree is inside the budget at 18s; an intruder measuring 40s must
    // not fail it.
    const without = [run(652, MERGED_HEAD, 18), run(651, "cc", 30)];
    const withSlow = [run(653, UNRELATED_HEAD, 40), ...without];
    const verdict = (runs: unknown) =>
      decideBudget({
        median: 24,
        currentTree: currentTreeFor(runs, [mergedPull]),
        budgetSeconds: BUDGET,
      });
    expect(verdict(withSlow).code).toBe(verdict(without).code);
    expect(expectCode(verdict(withSlow), "improving").current.work).toBe(18);
  });

  it("refuses the exemption when the head has no first-attempt run of its own", () => {
    // A re-run is not a first attempt, and a window that has aged past the head is not a licence to
    // use whatever is left.
    const rerunOnly = [run(653, UNRELATED_HEAD, 8), run(652, MERGED_HEAD, 18, 2)];
    const decision = decideBudget({
      median: 24,
      currentTree: currentTreeFor(rerunOnly, [mergedPull]),
      budgetSeconds: BUDGET,
    });
    expect(decision.ok).toBe(false);
    expect(expectCode(decision, "no-current-tree").refusal).toBe(NO_CURRENT_TREE.NO_RUN_FOR_HEAD);
  });

  it("refuses the exemption when two merged pull requests claim one commit", () => {
    const twice = [mergedPull, { ...mergedPull, number: 292 }];
    const decision = decideBudget({
      median: 24,
      currentTree: currentTreeFor(windowOf(18, 8), twice),
      budgetSeconds: BUDGET,
    });
    expect(decision.ok).toBe(false);
    expect(expectCode(decision, "no-current-tree").refusal).toBe(
      NO_CURRENT_TREE.AMBIGUOUS_PULL_REQUEST,
    );
  });

  it("refuses the exemption when the API's shape is not what it was", () => {
    // Fail closed about the mechanism, which is the rule the rest of the checker already follows: a
    // response this cannot read means the check has stopped checking.
    for (const pulls of [undefined, {}, "nope"]) {
      const decision = decideBudget({
        median: 24,
        currentTree: currentTreeFor(windowOf(18, 8), pulls),
        budgetSeconds: BUDGET,
      });
      expect(decision.ok).toBe(false);
      expect(expectCode(decision, "no-current-tree").refusal).toBe(NO_CURRENT_TREE.UNKNOWN_SHAPE);
    }
    expect(runForHead("nope", MERGED_HEAD).ok).toBe(false);
  });

  it("counts only merged pull requests, not one that has main merged into it", () => {
    // An open pull request carrying this commit did not produce it.
    const openOnly = [{ number: 300, merged_at: null, head: { sha: UNRELATED_HEAD } }];
    expect(currentTreePullRequest(openOnly, MAIN_SHA)).toMatchObject({
      ok: false,
      code: NO_CURRENT_TREE.NO_PULL_REQUEST,
    });
  });
});

describe("the checker asks for what it needs, and no longer asks by position", () => {
  it("selects the current-tree run by identity rather than by index", () => {
    // The defect, as a check. `samples[0]` is the newest run in the repository, which on a push to
    // `main` is whichever branch finished last.
    //
    // Comments stripped first, and deliberately: the file *should* still name `samples[0]` where it
    // explains what it used to do and why that was wrong. What it must not do is read it.
    const code = CHECKER.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    expect(code).not.toMatch(/samples\[0\]/);
    // And the explanation is still there, because deleting it loses the reason.
    expect(CHECKER).toContain("samples[0]");
    expect(CHECKER).toContain("currentTreePullRequest");
    expect(CHECKER).toContain("runForHead");
    expect(CHECKER).toContain("GITHUB_SHA");
  });

  it("grants the exemption from one place, so it cannot be granted from another", () => {
    // Every verdict comes out of `decideBudget`, so a future branch cannot quietly re-add a
    // recency-based pass beside it.
    expect(CHECKER).toContain("decideBudget(");
    expect(CHECKER.match(/decision\.code === /g) ?? []).toHaveLength(3);
  });

  it("asks the workflow for the permission the lookup needs", () => {
    // Without `pull-requests: read` the commits/pulls call is a 403, which `api()` fails on rather
    // than reading as "a direct push" — but a job that has to fail to tell you it is misconfigured
    // is worse than one that asked.
    const budgetJob = WORKFLOW.slice(WORKFLOW.indexOf("  ci-budget:"));
    const permissions = budgetJob.slice(0, budgetJob.indexOf("    steps:"));
    for (const permission of ["contents: read", "actions: read", "pull-requests: read"]) {
      expect(permissions, `ci-budget should request ${permission}`).toContain(permission);
    }
  });
});
