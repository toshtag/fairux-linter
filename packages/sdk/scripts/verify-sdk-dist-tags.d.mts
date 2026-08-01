export declare const SDK_BETA_CHANNEL: string;
export declare const SDK_BOOTSTRAP_TAG: string;

/** What the dist-tags must say once a beta version is published. */
export declare function auditSdkDistTags(input: {
  distTags: unknown;
  version: string;
  channel?: string;
}): string[];

/** What must not have changed, when a before-reading was taken. */
export declare function auditUnchangedDistTags(input: {
  before: unknown;
  after: unknown;
  channel?: string;
}): string[];
