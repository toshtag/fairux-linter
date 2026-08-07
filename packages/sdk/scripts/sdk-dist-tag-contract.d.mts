export declare const SDK_KNOWN_DIST_TAGS: readonly string[];
export declare const SDK_DIST_TAG_PHASES: readonly ["before-publish", "after-publish"];

/**
 * The gate that can still refuse: runs after the publication plan and before `npm publish`.
 *
 * @returns failures; empty means the publish may proceed
 */
export declare function auditSdkDistTagsBeforePublish(input: {
  distTags: unknown;
  version: string;
  distTag: string;
  publishNeeded: boolean;
}): string[];

/**
 * The confirmation: runs after the registry digest has been verified.
 *
 * @returns failures; empty means the tags are as the policy requires
 */
export declare function auditSdkDistTagsAfterPublish(input: {
  distTags: unknown;
  version: string;
  distTag: string;
}): string[];

/**
 * Compare the dist-tags before and after publishing.
 *
 * @returns failures; empty means every tag other than `channel` is exactly as it was
 */
export declare function auditUnchangedDistTags(input: {
  before: unknown;
  after: unknown;
  channel: string;
}): string[];
