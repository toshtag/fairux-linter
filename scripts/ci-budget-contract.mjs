/**
 * Which run describes the tree being gated, and what the budget makes of it.
 *
 * Split out of `check-ci-budget.mjs` so the decision can be tested without the API. Everything here
 * is a pure function of data somebody else fetched; nothing in this file knows what a network is.
 *
 * **The defect this exists to close.** The budget gained an exemption: a median over budget does not
 * fail if the lane has since been fixed, because a ten-run trailing median carries nine runs of a
 * tree that no longer exists. The first version read that "since" off `samples[0]` — the newest
 * successful pull-request run in the repository — which is not the same thing as the run for the
 * commit being gated. `release-contract.yml` runs on a push to `main`, and the newest pull-request
 * run at that moment belongs to whichever branch happened to finish last: an open pull request, a
 * closed one, somebody else's.
 *
 * Both directions were wrong, and neither is theoretical:
 *
 * - an unrelated *fast* run exempts a `main` that really is over budget;
 * - an unrelated *slow* run fails a `main` that has already been fixed.
 *
 * So the current-tree sample is chosen by identity, not by recency: the merged pull request that
 * produced this commit, and the run for that pull request's head. When that cannot be established —
 * a direct push, two merged pull requests claiming one commit, no run for the head — there is no
 * exemption to grant, and a median over budget fails. Substituting the newest unrelated run is the
 * bug, not the fallback.
 */

/** Why the current-tree sample could not be established. Each one refuses the exemption. */
export const NO_CURRENT_TREE = Object.freeze({
  NO_PULL_REQUEST: "no-pull-request",
  AMBIGUOUS_PULL_REQUEST: "ambiguous-pull-request",
  NO_RUN_FOR_HEAD: "no-run-for-head",
  UNKNOWN_SHAPE: "unknown-shape",
});

/**
 * The merged pull request that produced `sha`, or why there isn't exactly one.
 *
 * `GET /repos/{owner}/{repo}/commits/{sha}/pulls` lists every pull request a commit appears in,
 * which for a squash-merged commit is the one that produced it — and, for a commit that was pushed
 * straight to `main`, none at all. Both are answers; neither is "use something else".
 *
 * Only merged ones count. A commit can also appear in an *open* pull request that has `main` merged
 * into it, and that pull request did not produce this commit.
 */
export function currentTreePullRequest(pulls, sha) {
  if (!Array.isArray(pulls)) {
    return {
      ok: false,
      code: NO_CURRENT_TREE.UNKNOWN_SHAPE,
      detail: "the commits/pulls response is not an array",
    };
  }
  const merged = pulls.filter((pull) => pull?.merged_at);
  if (merged.length === 0) {
    return {
      ok: false,
      code: NO_CURRENT_TREE.NO_PULL_REQUEST,
      detail: `no merged pull request claims ${short(sha)} — a direct push, or a merge commit`,
    };
  }
  if (merged.length > 1) {
    // Two pull requests claiming one commit is a history this cannot reason about, and picking one
    // would be the same guess as picking the newest run.
    return {
      ok: false,
      code: NO_CURRENT_TREE.AMBIGUOUS_PULL_REQUEST,
      detail: `${merged.length} merged pull requests claim ${short(sha)}: ${merged
        .map((pull) => `#${pull.number}`)
        .join(", ")}`,
    };
  }
  const pull = merged[0];
  const head = pull?.head?.sha;
  if (typeof head !== "string" || head.length === 0) {
    return {
      ok: false,
      code: NO_CURRENT_TREE.UNKNOWN_SHAPE,
      detail: `pull request #${pull?.number} reports no head sha`,
    };
  }
  return { ok: true, number: pull.number, headSha: head };
}

/**
 * The first-attempt run for a given head, out of runs already filtered to successful and
 * pull-request.
 *
 * By `head_sha`, because that is what ties a run to a tree. A run's `head_branch` is a name that
 * gets reused and a run's position in the list is what this file exists to stop trusting.
 */
export function runForHead(runs, headSha) {
  if (!Array.isArray(runs)) {
    return {
      ok: false,
      code: NO_CURRENT_TREE.UNKNOWN_SHAPE,
      detail: "the runs response is not an array",
    };
  }
  const match = runs.find((run) => run?.head_sha === headSha && (run.run_attempt ?? 1) === 1);
  if (!match) {
    return {
      ok: false,
      code: NO_CURRENT_TREE.NO_RUN_FOR_HEAD,
      detail: `no first-attempt successful run of the lane for head ${short(headSha)}`,
    };
  }
  return { ok: true, run: match };
}

function short(sha) {
  return typeof sha === "string" ? sha.slice(0, 7) : String(sha);
}

/**
 * What the budget makes of a window and a current-tree sample.
 *
 * `median` is the drift signal and is measured from the window exactly as before — the window is
 * every recent first-attempt successful pull-request run, unchanged by this file.
 *
 * `currentTree` is either `{ ok: true, work, label }` or a refusal from the two functions above. A
 * refusal never grants the exemption; it explains, in the failure, why there was nothing to grant it
 * with.
 */
export function decideBudget({ median, currentTree, budgetSeconds }) {
  if (median <= budgetSeconds) {
    return { ok: true, code: "within-budget", median };
  }
  if (!currentTree?.ok) {
    return {
      ok: false,
      code: "no-current-tree",
      median,
      detail: currentTree?.detail ?? "the current tree's run could not be identified",
      refusal: currentTree?.code ?? NO_CURRENT_TREE.UNKNOWN_SHAPE,
    };
  }
  if (currentTree.work > budgetSeconds) {
    return { ok: false, code: "over-budget", median, current: currentTree };
  }
  return { ok: true, code: "improving", median, current: currentTree };
}
