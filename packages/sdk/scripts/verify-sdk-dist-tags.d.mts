export declare const SDK_BETA_CHANNEL: string;
export declare const SDK_BOOTSTRAP_TAG: string;

/** What the dist-tags must say once a beta version is published — current values only. */
export declare function auditSdkDistTags(input: {
  distTags: unknown;
  version: string;
  channel?: string;
}): string[];

/** What must not have changed. A current-value check cannot express this. */
export declare function auditUnchangedDistTags(input: {
  before: unknown;
  after: unknown;
  channel?: string;
}): string[];

/** Read the pre-publish snapshot, fail-closed on every unreadable form. */
export declare function readDistTagSnapshot(
  filePath: string,
): { distTags: Record<string, unknown> } | { error: string };
