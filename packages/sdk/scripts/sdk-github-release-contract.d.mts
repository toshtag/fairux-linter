export declare const SDK_RELEASE_VIEW_FIELDS: readonly ["tagName", "isDraft", "isPrerelease"];

/**
 * Decide whether an existing GitHub Release may be repaired in place.
 *
 * @returns failures; empty means the Release is already classified as this release requires
 */
export declare function auditExistingSdkRelease(input: {
  expectedTag: string;
  expectedPrerelease: boolean;
  release: unknown;
}): string[];
