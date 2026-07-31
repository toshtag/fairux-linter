export declare const CLI_KNOWN_DIST_TAGS: readonly string[];

/** The two sides of `npm publish` this module audits. */
export declare const CLI_DIST_TAG_PHASES: readonly ["before-publish", "after-publish"];

export type CliDistTagPhase = (typeof CLI_DIST_TAG_PHASES)[number];

/**
 * The gate that can still refuse: runs after the publication plan and before `npm publish`.
 *
 * An unexpected channel state detected only after the publish is detected once the version has been
 * permanently consumed — npm never lets a name/version pair be reused.
 *
 * @returns failures; empty means the publish may proceed
 */
export declare function auditCliDistTagsBeforePublish(input: {
  distTags: unknown;
  version: string;
  distTag: string;
  /** The publication plan's answer. It decides what `next` is allowed to be. */
  publishNeeded: boolean;
}): string[];

/**
 * The confirmation: runs after the registry digest has been verified.
 *
 * @returns failures; empty means the tags are as the policy requires
 */
export declare function auditCliDistTagsAfterPublish(input: {
  distTags: unknown;
  version: string;
  distTag: string;
}): string[];
