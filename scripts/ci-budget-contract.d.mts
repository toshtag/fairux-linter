/** Why the current-tree sample could not be established. Each one refuses the exemption. */
export declare const NO_CURRENT_TREE: {
  readonly NO_PULL_REQUEST: "no-pull-request";
  readonly AMBIGUOUS_PULL_REQUEST: "ambiguous-pull-request";
  readonly NO_RUN_FOR_HEAD: "no-run-for-head";
  readonly UNKNOWN_SHAPE: "unknown-shape";
};

export type NoCurrentTreeCode = (typeof NO_CURRENT_TREE)[keyof typeof NO_CURRENT_TREE];

/** A refusal to name a current-tree sample. Never a reason to substitute another run. */
export interface CurrentTreeRefusal {
  readonly ok: false;
  readonly code: NoCurrentTreeCode;
  readonly detail: string;
}

export interface CurrentTreePullRequest {
  readonly ok: true;
  readonly number: number;
  readonly headSha: string;
}

/** The merged pull request that produced `sha`, or why there is not exactly one. */
export declare function currentTreePullRequest(
  pulls: unknown,
  sha: string,
): CurrentTreePullRequest | CurrentTreeRefusal;

/** The first-attempt run whose `head_sha` is `headSha`, or why there is none. */
export declare function runForHead(
  runs: unknown,
  headSha: string,
): { readonly ok: true; readonly run: Record<string, unknown> } | CurrentTreeRefusal;

/** The current tree's measured work, once a run has been found and split. */
export interface CurrentTreeSample {
  readonly ok: true;
  readonly work: number;
  readonly label: string;
}

export type BudgetDecision =
  | { readonly ok: true; readonly code: "within-budget"; readonly median: number }
  | {
      readonly ok: true;
      readonly code: "improving";
      readonly median: number;
      readonly current: CurrentTreeSample;
    }
  | {
      readonly ok: false;
      readonly code: "over-budget";
      readonly median: number;
      readonly current: CurrentTreeSample;
    }
  | {
      readonly ok: false;
      readonly code: "no-current-tree";
      readonly median: number;
      readonly detail: string;
      readonly refusal: NoCurrentTreeCode;
    };

/** What the budget makes of a window's median and the current tree's own sample. */
export declare function decideBudget(input: {
  readonly median: number;
  readonly currentTree: CurrentTreeSample | CurrentTreeRefusal | undefined;
  readonly budgetSeconds: number;
}): BudgetDecision;
