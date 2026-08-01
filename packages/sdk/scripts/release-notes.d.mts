export declare const SDK_PACKAGE_NAME: "@fairux/sdk";
export declare const SDK_BETA_DIST_TAG: "next";
export declare const SDK_RELEASE_CHECKSUM_FILE: "release-sha256.txt";
export declare const SDK_REPOSITORY_URL: "https://github.com/toshtag/fairux-linter";
export declare const SDK_RELEASE_NOTES_SCRIPT: "packages/sdk/scripts/release-notes.mjs";
export declare const SDK_MANIFEST_PATH: "packages/sdk/package.json";
export declare const SDK_PUBLIC_ENTRY_POINTS: readonly string[];
export declare const SDK_RELEASE_SECTIONS: readonly string[];

export declare class SdkReleaseNotesError extends Error {
  readonly name: "SdkReleaseNotesError";
}

/**
 * Every fact the Release body may state, and nothing else.
 *
 * The manifest fields come from the privileged job's own checkout; `tag`, `sourceCommit`,
 * `npmDistTag`, `tarballFilename`, and `checksumFilename` come from values that job already
 * verified. The generator refuses any of them that is not the expected one.
 */
export type SdkReleaseNotesInput = {
  readonly packageName: string;
  readonly version: string;
  readonly description: string;
  readonly nodeEngines: string;
  readonly publicEntryPoints: readonly string[];
  readonly repositoryUrl: string;
  readonly tag: string;
  readonly sourceCommit: string;
  readonly npmDistTag: string;
  readonly tarballFilename: string;
  readonly checksumFilename: string;
  /**
   * Facts the privileged publish job checked for itself.
   *
   * An absent flag narrows the corresponding claim rather than asserting it. Booleans only: a claim
   * in these notes is either something the workflow checked or it is not.
   */
  readonly verified?: {
    /** The no-npm-credential preflight ran and passed, before and after the publish. */
    readonly credentialPreflight?: boolean;
    /** The registry's attestation metadata was read back for this exact version. */
    readonly provenanceAttested?: boolean;
  };
};

/**
 * The plain HTTPS URL a manifest `repository` field points at.
 *
 * Throws `SdkReleaseNotesError` unless it reduces to exactly `https://github.com/<owner>/<repo>`.
 */
export declare function repositoryHttpsUrl(repository: unknown): string;

/**
 * The public entry points a manifest declares, in manifest order, excluding `./package.json`.
 */
export declare function sdkPublicEntryPoints(manifest: unknown): string[];

/** Assemble the generator's input from a manifest plus the publish job's verified values. */
export declare function sdkReleaseNotesInput(input: {
  manifest: unknown;
  tag: string;
  sourceCommit: string;
  npmDistTag: string;
  tarballFilename: string;
  checksumFilename: string;
  verified?: SdkReleaseNotesInput["verified"];
}): SdkReleaseNotesInput;

/**
 * The whole `node` argv for one release's notes, derived from the three values that vary.
 *
 * Callers pass this to `node` rather than assembling the option list themselves, so a signature
 * change cannot leave a caller behind — which is how the release dry run stopped rehearsing the
 * publish job's invocation.
 */
export declare function sdkReleaseNotesInvocation(input: {
  /** Verified-fact flags to append. Presence-only; there is no negating form. */
  verified?: SdkReleaseNotesInput["verified"];
  tag: string;
  sourceCommit: string;
  tarball: string;
  out?: string;
}): string[];

/** The GitHub Release title: `@fairux/sdk 0.1.0-beta.2`, with no duplicated `v`. */
export declare function sdkReleaseTitle(input: { packageName: string; version: string }): string;

/**
 * Render the GitHub Release body for one SDK beta.
 *
 * Pure and deterministic — no filesystem, process, network, or clock. Throws
 * `SdkReleaseNotesError` for any input the notes are not allowed to describe. The result ends in
 * exactly one newline.
 */
export declare function generateSdkReleaseNotes(input: SdkReleaseNotesInput): string;
