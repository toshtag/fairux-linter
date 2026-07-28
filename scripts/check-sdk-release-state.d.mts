export type SdkReleaseAsset = {
  readonly id: number;
  readonly name: string;
  readonly size: number;
  readonly digest: string;
  readonly content_type: string;
};

export type SdkReleaseStateContract = {
  readonly tag: string;
  /** The branch the Release records. Not the commit the artifact was built from — see `tagCommit`. */
  readonly targetCommitish: string;
  readonly tagCommit: string;
  readonly prerelease: boolean;
  readonly draft: boolean;
  readonly assets: readonly SdkReleaseAsset[];
  readonly npm: {
    readonly version: string;
    readonly shasum: string;
    readonly integrity: string;
    readonly tarball: string;
    readonly fileCount: number;
    readonly unpackedSize: number;
  };
  readonly distTags: Readonly<Record<string, string>>;
};

/** The recorded state of the published Release, its package, and the package's dist-tags. */
export declare const EXPECTED_SDK_RELEASE_STATE: SdkReleaseStateContract;

/** What the corrected Release must be titled. */
export declare const EXPECTED_SDK_RELEASE_TITLE: "@fairux/sdk 0.1.0-beta.2";

/**
 * The tag as GitHub holds it. `sdk-v0.1.0-beta.2` is annotated, so the ref names a tag object and
 * only its dereference names the commit.
 */
export declare const EXPECTED_SDK_TAG_REF: {
  readonly ref: string;
  readonly objectType: "tag";
  readonly tagObject: string;
};

/** Every way the tag GitHub holds fails to be the one this Release was built from. */
export declare function validateExpectedSdkTagRef(input: {
  ref: unknown;
  tagObject: unknown;
}): string[];

/** The tag identity two captures are compared by. */
export declare function immutableSdkTagProjection(input: {
  ref: unknown;
  tagObject: unknown;
}): unknown;

/**
 * The title and body the correction was supposed to produce.
 *
 * A `gh release edit` command carrying the right `--title` says what was asked for; this says what
 * is published.
 */
export declare function validateCorrectedSdkReleasePresentation(input: {
  release: unknown;
  generatedBody: string;
}): string[];

/**
 * Every way a captured state fails to be the one the correction procedure may edit.
 *
 * Absence is a failure, never a match: a missing asset digest or an empty `dist` is reported, not
 * compared away against another capture's absence.
 */
export declare function validateExpectedSdkReleaseState(input: {
  release: unknown;
  npmMetadata: unknown;
  distTags: unknown;
}): string[];

/** The enumerated fields the edit must leave alone, in a form two captures can be compared by. */
export declare function immutableSdkReleaseProjection(input: {
  release: unknown;
  npmMetadata: unknown;
  distTags: unknown;
}): unknown;

/** Differences between two projections, or an empty list. */
export declare function compareSdkReleaseStates(before: unknown, after: unknown): string[];

/**
 * Compare a published body against the generated file, folding CRLF to LF and nothing else.
 *
 * A standalone carriage return is a failure rather than something to strip. Exact source-text
 * equality on decoded strings, not a byte comparison.
 */
export declare function compareSdkReleaseBody(published: unknown, generated: string): string[];
