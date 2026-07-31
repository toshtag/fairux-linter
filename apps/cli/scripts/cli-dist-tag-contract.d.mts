export declare const CLI_KNOWN_DIST_TAGS: readonly string[];

/**
 * Decide whether the registry's dist-tags match the CLI's channel policy.
 *
 * Pure: the caller reads the registry, this decides what the reading means.
 *
 * @returns failures; empty means the tags are as the policy requires
 */
export declare function auditCliDistTags(input: {
  distTags: unknown;
  version: string;
  distTag: string;
}): string[];
