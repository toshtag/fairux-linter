export declare const CANARY_TOOL_NAME: string;
export declare const CANARY_CATEGORIES: Readonly<{
  physical: string;
  logical: string;
  logicalNoLocations: string;
  logicalInputFile: string;
}>;
export declare const CANARY_CATEGORY_LIST: readonly string[];

/** Refuse any ref that is not this canary's own branch, or that is the default branch. */
export declare function assertCanaryRef(
  ref: unknown,
  repository: { defaultBranch: string },
): string;

/** Refuse anything that is not a full 40-character commit SHA. */
export declare function assertCommitSha(sha: unknown, label: string): string;

/** Set `runs[].automationDetails.id`, optionally clearing the results. The input is not mutated. */
export declare function prepareCanarySarif(
  sarif: unknown,
  options: {
    category: string;
    empty?: boolean;
    /** `none` drops the locations key; `input-file` names the scanned file with no region. */
    locationShape?: "as-emitted" | "none" | "input-file";
    artifactUri?: string;
  },
): { runs: { results: unknown[]; automationDetails: { id: string } }[] };

/** Split a repository's analyses into this canary's own and everything else. */
export declare function partitionCanaryAnalyses(
  analyses: readonly unknown[] | undefined,
  canary: { ref: string; tool: string; categories: readonly string[] },
): { targets: Record<string, unknown>[]; foreign: Record<string, unknown>[] };

/** The reason a set of analyses must not be deleted, or `null`. */
export declare function undeletableAnalysisSet(
  partition: { targets: unknown[]; foreign: unknown[] },
  canary: { ref: string },
): string | null;

/** What the line-move stage observed, as a decided answer rather than two raw alert lists. */
export declare function alertIdentityAcrossMove(alerts: { before: unknown; after: unknown }): {
  sameAlertNumber: boolean | null;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  generatedFingerprint: string | null;
  note: string;
};

/** How a logical-only result — no source file at all — came back. */
export declare function logicalOnlyAlertShape(alert: unknown): {
  present: boolean;
  ruleId: string | null;
  path: string | null;
  startLine: number | null;
  state: string | null;
};
