/** One level-2 release heading, as it appears in `CHANGELOG.md`. */
export interface ReleaseHeading {
  /** 1-based, so a violation can name the line a reader has to open. */
  readonly line: number;
  readonly name: string;
  readonly version: string;
  readonly date: string;
}

/** The one shape a released section may take. */
export declare const RELEASE_HEADING: RegExp;

/** Every level-2 release heading in `changelog`, in file order. `## [Unreleased]` is not one. */
export declare function releaseHeadings(changelog: string): ReleaseHeading[];

/**
 * What is wrong with `changelog` as a record of releasing `name@version`.
 *
 * Empty means the entry is there and well-formed. Anything else is a sentence naming the rule and
 * the line, for a reader who has to fix it.
 */
export declare function validateChangelogReleaseEntry(
  changelog: string,
  entry: { readonly name: string; readonly version: string },
): string[];
