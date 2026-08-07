export declare const SDK_PACKAGE_NAME: "@fairux/sdk";
export declare const SDK_TAG_PREFIX: "sdk-v";
export declare const SDK_RUNBOOK: string;
export declare const SDK_BOOTSTRAP_VERSION: string;
export declare const SDK_BOOTSTRAP_DIST_TAG: string;
export declare const SDK_PRERELEASE_DIST_TAG: string;
export declare const SDK_STABLE_DIST_TAG: string;
export declare const SDK_RELEASE_CHECKSUM_FILE: string;

export declare class SdkReleaseError extends Error {}

/** The tag that releases a given version. */
export declare function sdkReleaseTag(version: string): string;

/**
 * Resolve a git tag into the release it names, or throw `SdkReleaseError`.
 *
 * A prerelease of any kind publishes to `next`; a version with no prerelease identifier publishes
 * to `latest`. The bootstrap placeholder is refused before a dist-tag is derived for it.
 */
export declare function resolveSdkRelease(tag: string): {
  tag: string;
  version: string;
  prerelease: boolean;
  distTag: string;
};

/** The tarball `pnpm pack` writes for a release. */
export declare function sdkTarballName(version: string): string;

/** `@fairux/sdk@<version>`. */
export declare function sdkReleaseSpec(version: string): string;
