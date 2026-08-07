export declare const BOOTSTRAP_DIST_TAG: "bootstrap";
export declare const PRERELEASE_DIST_TAG: "next";
export declare const STABLE_DIST_TAG: "latest";
export declare const BOOTSTRAP_VERSION: "0.0.0-bootstrap.0";
export declare const KNOWN_DIST_TAGS: readonly string[];

/** The two sides of `npm publish` these audits describe. */
export declare const DIST_TAG_PHASES: readonly ["before-publish", "after-publish"];

export interface DistTagContract {
  /**
   * The gate that can still refuse: runs after the publication plan and before `npm publish`.
   *
   * An unexpected channel state detected only after the publish is detected once the version has
   * been permanently consumed — npm never lets a name/version pair be reused.
   *
   * @returns failures; empty means the publish may proceed
   */
  auditBeforePublish(input: {
    distTags: unknown;
    version: string;
    distTag: string;
    /** The publication plan's answer. It decides what this release's channel is allowed to be. */
    publishNeeded: boolean;
  }): string[];

  /**
   * The confirmation: runs after the registry digest has been verified.
   *
   * @returns failures; empty means the tags are as the policy requires
   */
  auditAfterPublish(input: { distTags: unknown; version: string; distTag: string }): string[];
}

/** Bind the shared channel policy to one package's name and runbook. */
export declare function createDistTagContract(binding: {
  packageName: string;
  runbook: string;
  bootstrapVersion?: string;
}): DistTagContract;

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
