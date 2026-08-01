/**
 * What the SARIF upload canary is allowed to touch, and what its observations mean.
 *
 * The canary uploads real SARIF to real GitHub code scanning and then deletes what it created.
 * Both halves are dangerous in the same way: an upload aimed at the wrong ref writes into the
 * default branch's alert set, and a delete aimed at the wrong analysis destroys someone else's
 * evidence. Neither is recoverable by rerunning.
 *
 * So the rules live here as pure functions, checked without a network call, and the I/O script does
 * nothing they have not first permitted. A refusal that only exists inside the code path it guards
 * is a refusal nobody has read.
 *
 * Node built-ins only — this runs in a workflow with no dependency tree installed.
 */

/**
 * The only ref shape this canary may write to.
 *
 * Unique per run by construction: the short SHA of the `main` it was cut from. A fixed name would
 * let two runs share an analysis set, and the second one's cleanup would then delete the first's
 * evidence while its assertions still passed.
 */
const CANARY_REF_PATTERN = /^refs\/heads\/fairux-sarif-canary-[0-9a-f]{7,40}$/;

/** The tool name FairUX SARIF carries. Fixed for the canary: it is half of an analysis set's key. */
export const CANARY_TOOL_NAME = "FairUX";

/**
 * The categories this canary owns, versioned so a later canary cannot join one of its analysis
 * sets.
 *
 * Two, not one, because the two things being observed cannot share an upload. GitHub keys an
 * analysis set by ref, tool, and category, and a later upload into a set replaces the earlier one —
 * so a single category would have the Figma upload closing the HTML alert as fixed, which is
 * exactly the signal stage C is supposed to produce deliberately. The two fixtures also come from
 * different adapters and cannot be one SARIF run.
 *
 * Listed exhaustively rather than matched by prefix. `fairux-sarif-canary-v10` starts with
 * `fairux-sarif-canary-v1`, and a delete is not the place to find that out.
 */
export const CANARY_CATEGORIES = Object.freeze({
  /** The HTML fixture: one finding with a physical source location. Stages A, B, and C. */
  physical: "fairux-sarif-canary-v1-physical",
  /** The Figma fixture: one finding with logical locations only, and no source file at all. */
  logical: "fairux-sarif-canary-v1-logical",
});

/** Every category this canary may create or delete. */
export const CANARY_CATEGORY_LIST = Object.freeze(Object.values(CANARY_CATEGORIES));

/**
 * Set `runs[].automationDetails.id`, which is what GitHub reads as an analysis set's category.
 *
 * The reporter does not emit it: a category is a property of one upload into one repository's
 * code scanning, not of a FairUX report, and putting it in the reporter would make every consumer's
 * SARIF carry this canary's identity.
 *
 * @param {object} sarif  a parsed SARIF log
 * @param {{category: string, empty?: boolean}} options  `empty` clears the results, which is how
 *   stage C asks GitHub whether it closes an alert that stopped being reported
 * @returns {object} a new log; the input is not mutated
 */
export function prepareCanarySarif(sarif, { category, empty = false }) {
  if (!CANARY_CATEGORY_LIST.includes(category)) {
    throw new Error(`refusing category ${JSON.stringify(category)}: not one of this canary's`);
  }
  const runs = sarif?.runs;
  if (!Array.isArray(runs) || runs.length !== 1) {
    throw new Error(
      `expected exactly one SARIF run for a canary upload, got ${Array.isArray(runs) ? runs.length : "none"}`,
    );
  }
  return {
    ...sarif,
    runs: [
      {
        ...runs[0],
        automationDetails: { id: category },
        results: empty ? [] : (runs[0].results ?? []),
      },
    ],
  };
}

/**
 * Refuse any ref that is not this canary's own branch.
 *
 * The default branch is refused by name as well as by pattern. That is not redundant: a repository
 * whose default branch was renamed to something matching the pattern would otherwise pass, and the
 * consequence — canary alerts in the default branch's view, and a cleanup that deletes real
 * analyses — is exactly what this function exists to prevent.
 *
 * @param {unknown} ref
 * @param {{defaultBranch: string}} repository
 * @returns {string} the ref, when it is allowed
 * @throws when it is not
 */
export function assertCanaryRef(ref, { defaultBranch }) {
  if (typeof ref !== "string" || !CANARY_REF_PATTERN.test(ref)) {
    throw new Error(
      `refusing ref ${JSON.stringify(ref)}: the SARIF canary writes only to ` +
        "refs/heads/fairux-sarif-canary-<main-short-sha>",
    );
  }
  if (ref === `refs/heads/${defaultBranch}`) {
    throw new Error(`refusing ref ${ref}: it is the default branch`);
  }
  return ref;
}

/**
 * Refuse anything that is not a full commit SHA.
 *
 * Abbreviated SHAs and branch names are both accepted by parts of GitHub's API and would make the
 * uploaded analysis point somewhere other than where the evidence says it does.
 *
 * @param {unknown} sha
 * @param {string} label
 * @returns {string}
 */
export function assertCommitSha(sha, label) {
  if (typeof sha !== "string" || !/^[0-9a-f]{40}$/.test(sha)) {
    throw new Error(`refusing ${label} ${JSON.stringify(sha)}: expected a full 40-character SHA`);
  }
  return sha;
}

/**
 * Split a repository's analyses into the canary's own and everything else.
 *
 * The caller deletes `targets` and must refuse to proceed when `foreign` is non-empty. Both halves
 * are returned rather than just the targets, because "there is nothing else here" is the assertion
 * that makes deleting safe, and a function that silently filtered would leave the caller asserting
 * on a set it did not see.
 *
 * Matching is exact on ref and tool, and against an exhaustive list of categories. A prefix or
 * substring match would fold `fairux-sarif-canary-v10` into `fairux-sarif-canary-v1`.
 *
 * @param {readonly {id?: number, ref?: string, category?: string, tool?: {name?: string}}[]} analyses
 * @param {{ref: string, tool: string, categories: readonly string[]}} canary
 * @returns {{targets: object[], foreign: object[]}}
 */
export function partitionCanaryAnalyses(analyses, { ref, tool, categories }) {
  const targets = [];
  const foreign = [];
  for (const analysis of analyses ?? []) {
    const isCanary =
      analysis?.ref === ref &&
      analysis?.tool?.name === tool &&
      typeof analysis?.category === "string" &&
      categories.includes(analysis.category) &&
      typeof analysis?.id === "number";
    (isCanary ? targets : foreign).push(analysis);
  }
  return { targets, foreign };
}

/**
 * The reason a set of analyses must not be deleted, or `null`.
 *
 * Only the presence of something foreign refuses. An empty target set is not an error: a cleanup
 * rerun after a successful one finds nothing, and treating that as a failure would push the owner
 * toward ignoring this command's exit code.
 *
 * @param {{targets: object[], foreign: object[]}} partition
 * @param {{ref: string}} canary
 * @returns {string | null}
 */
export function undeletableAnalysisSet({ foreign }, { ref }) {
  if (foreign.length === 0) return null;
  const described = foreign
    .slice(0, 5)
    .map((a) => `${a?.ref ?? "?"}/${a?.tool?.name ?? "?"}/${a?.category ?? "?"}`);
  return (
    `refusing to delete: the listed analyses for ${ref} include ${foreign.length} that are not ` +
    `this canary's (${described.join(", ")})`
  );
}

/**
 * What the line-move stage observed, as a decided answer rather than two raw alert lists.
 *
 * This is the question [#78](https://github.com/toshtag/fairux-linter/issues/78) left open. FairUX
 * stopped emitting `partialFingerprints.primaryLocationLineHash` because the value it computed
 * moved with the line — and because supplying the field at all made `upload-sarif` skip generating
 * a correct one. Whether GitHub then generates its own has never been observed, and the observable
 * consequence is exactly this: after the finding moves to a different line, is it the same alert?
 *
 * `sameAlertNumber` is the fact. `generatedFingerprint` is the mechanism, and it is reported
 * separately because the alerts API may not expose it — an absent fingerprint is not evidence that
 * none was generated, and this must not be recorded as if it were.
 *
 * @param {{before: object | undefined, after: object | undefined}} alerts
 * @returns {{sameAlertNumber: boolean | null, before: object | null, after: object | null,
 *   generatedFingerprint: string | null, note: string}}
 */
export function alertIdentityAcrossMove({ before, after }) {
  const summarize = (alert) =>
    alert
      ? {
          number: alert.number,
          ruleId: alert.rule?.id,
          state: alert.state,
          path: alert.most_recent_instance?.location?.path,
          startLine: alert.most_recent_instance?.location?.start_line,
        }
      : null;

  const beforeSummary = summarize(before);
  const afterSummary = summarize(after);
  const sameAlertNumber =
    beforeSummary && afterSummary ? beforeSummary.number === afterSummary.number : null;

  const fingerprint =
    after?.most_recent_instance?.partial_fingerprints?.primaryLocationLineHash ??
    before?.most_recent_instance?.partial_fingerprints?.primaryLocationLineHash ??
    null;

  return {
    sameAlertNumber,
    before: beforeSummary,
    after: afterSummary,
    generatedFingerprint: fingerprint,
    note:
      fingerprint === null
        ? "the alerts API exposed no primaryLocationLineHash; absence here is not evidence that GitHub generated none"
        : "GitHub reported a primaryLocationLineHash for a SARIF that supplied none",
  };
}

/**
 * How a logical-only result — a DOM or Figma finding with no source file — came back.
 *
 * The second unproven claim. FairUX emits `logicalLocations` and no `physicalLocation` for these,
 * which SARIF permits; what code scanning displays for them, and whether it deduplicates them at
 * all, is undocumented for this shape.
 *
 * @param {object | undefined} alert
 * @returns {{present: boolean, ruleId: string | null, path: string | null,
 *   startLine: number | null, state: string | null}}
 */
export function logicalOnlyAlertShape(alert) {
  return {
    present: Boolean(alert),
    ruleId: alert?.rule?.id ?? null,
    // A logical-only result has no source file. Whatever GitHub puts here — a placeholder, the
    // SARIF file's own path, or nothing — is the observation.
    path: alert?.most_recent_instance?.location?.path ?? null,
    startLine: alert?.most_recent_instance?.location?.start_line ?? null,
    state: alert?.state ?? null,
  };
}
