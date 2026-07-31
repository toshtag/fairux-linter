export declare const CLI_PACKAGE_NAME: "fairux";
export declare const CLI_TAG_PREFIX: "v";
export declare const CLI_BOOTSTRAP_VERSION: "0.0.0-bootstrap.0";
export declare const CLI_BOOTSTRAP_DIST_TAG: "bootstrap";
export declare const CLI_PRERELEASE_DIST_TAG: "next";
export declare const CLI_STABLE_DIST_TAG: "latest";
export declare const CLI_RELEASE_CHECKSUM_FILE: "release-sha256.txt";
export declare const CLI_PUBLISHED_FILES: readonly string[];
export declare const CLI_LICENSE: "Apache-2.0";
/** The exact supported Node.js range. Widening it is a support-policy change, not a manifest edit. */
export declare const CLI_NODE_ENGINES: "^22.18.0 || >=24.11.0";
/** The exact `prepublishOnly` command, so the guard cannot be replaced by another string. */
export declare const CLI_PREPUBLISH_GUARD: "node scripts/prepublish-guard.mjs";
export declare const CLI_REPOSITORY_DIRECTORY: "apps/cli";
export declare const CLI_BIN_NAME: "fairux";
export declare const CLI_BIN_PATH: "./dist/index.js";

export declare class CliReleaseError extends Error {
  readonly name: "CliReleaseError";
}

export interface CliRelease {
  tag: string;
  version: string;
  prerelease: boolean;
  distTag: string;
}

export declare function cliReleaseTag(version: string): string;

/** Throws `CliReleaseError` for a tag this workflow must not release. */
export declare function resolveCliRelease(tag: string): CliRelease;

export declare function auditCliReleaseManifest(input: {
  manifest: unknown;
  tag?: string;
}): string[];

export declare function cliTarballName(version: string): string;
export declare function cliReleaseSpec(version: string): string;
