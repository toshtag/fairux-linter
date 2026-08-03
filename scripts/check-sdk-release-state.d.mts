export type SdkReleaseAsset = {
  readonly id: number;
  readonly name: string;
  readonly size: number;
  readonly digest: string;
  readonly content_type: string;
};

/**
 * What one release is expected to be, supplied by the caller rather than carried by this module.
 *
 * It is therefore untrusted input — see `validateSdkReleaseExpectation`, which every entry point
 * runs before it compares anything.
 */
export type SdkReleaseStateContract = {
  readonly tag: string;
  /** The branch the Release records. Not the commit the artifact was built from — see `tagCommit`. */
  readonly targetCommitish: string;
  readonly tagCommit: string;
  /** The tag object an annotated tag's ref names, before dereferencing to `tagCommit`. */
  readonly tagRefObject: string;
  /** What the corrected Release must be titled. */
  readonly title: string;
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

/**
 * Every way the expectation itself is unusable, checked before it is compared against anything.
 *
 * Making the expected state a parameter reopened the failure mode this module exists to prevent: an
 * absent or half-written expectation must be a refusal, never an empty comparison that reports a
 * match. Every field is required.
 */
export declare function validateSdkReleaseExpectation(expected: unknown): string[];

/** Every way the tag GitHub holds fails to be the one this Release was built from. */
export declare function validateExpectedSdkTagRef(
  input: { ref: unknown; tagObject: unknown },
  expected: SdkReleaseStateContract,
): string[];

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
export declare function validateCorrectedSdkReleasePresentation(
  input: { release: unknown; generatedBody: string },
  expectedTitle: string,
): string[];

/**
 * Every way a captured state fails to be the one the correction procedure may edit.
 *
 * Absence is a failure, never a match: a missing asset digest or an empty `dist` is reported, not
 * compared away against another capture's absence.
 */
export declare function validateExpectedSdkReleaseState(
  input: { release: unknown; npmMetadata: unknown; distTags: unknown },
  expected: SdkReleaseStateContract,
): string[];

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
