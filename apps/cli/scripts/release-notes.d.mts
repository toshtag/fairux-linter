export declare const CLI_REPOSITORY_URL: "https://github.com/toshtag/fairux-linter";
export declare const CLI_RELEASE_SECTIONS: readonly string[];
export declare const CLI_RELEASE_NOTES_SCRIPT: "apps/cli/scripts/release-notes.mjs";
export declare const CLI_MANIFEST_PATH: "apps/cli/package.json";

/** A capability the CLI ships, named by the flags a reader can check against `fairux scan --help`. */
export interface CliShippedCapability {
  readonly id: string;
  readonly flags: readonly string[];
  readonly keywords: readonly string[];
}

export declare const CLI_SHIPPED_CAPABILITIES: readonly CliShippedCapability[];

/** Limitations that are true of the engine, as Markdown list items. Not the channel caveats. */
export declare const CLI_RELEASE_LIMITATIONS: readonly string[];

export declare class CliReleaseNotesError extends Error {
  readonly name: "CliReleaseNotesError";
}

/** Every release-variable fact the notes may state. Nothing else reaches the body. */
export interface CliReleaseNotesInput {
  packageName: string;
  version: string;
  description: string;
  nodeEngines: string;
  repositoryUrl: string;
  tag: string;
  sourceCommit: string;
  npmDistTag: string;
  tarballFilename: string;
  checksumFilename: string;
}

export declare function repositoryHttpsUrl(
  repository: string | { url?: string } | undefined,
): string;

export declare function cliReleaseNotesInput(input: {
  manifest: unknown;
  tag: string;
  sourceCommit: string;
  npmDistTag: string;
  tarballFilename: string;
  checksumFilename: string;
}): CliReleaseNotesInput;

/** `fairux 0.1.0-beta.1` — no duplicated `v`, which is what `sdk-v0.1.0-beta.2` shipped. */
export declare function cliReleaseTitle(input: { packageName: string; version: string }): string;

/** Deterministic and clockless: the same input renders the same bytes, so re-runs are idempotent. */
export declare function generateCliReleaseNotes(input: CliReleaseNotesInput): string;

/** The whole `node` argv, so a workflow contract test can compare it rather than grep for flags. */
export declare function cliReleaseNotesInvocation(input: {
  tag: string;
  sourceCommit: string;
  tarball: string;
  out?: string;
}): string[];
