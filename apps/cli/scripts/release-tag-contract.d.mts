export declare class CliReleaseTagError extends Error {
  readonly name: "CliReleaseTagError";
}

export interface ResolvedRemoteTag {
  commit: string;
  /** True when the commit came from the peeled `refs/tags/<t>^{}` ref rather than the tag ref. */
  annotated: boolean;
}

/**
 * Resolve one tag from `git ls-remote --tags` output.
 *
 * Pure: takes stdout as text, runs nothing. Throws when the tag is absent, when either ref resolves
 * to more than one commit, or when the output is not `<sha>\t<ref>` lines.
 */
export declare function resolveRemoteTag(input: { tag: string; output: string }): ResolvedRemoteTag;

/** {@link resolveRemoteTag}, additionally requiring the tag to name `expectedCommit`. */
export declare function verifyRemoteTagCommit(input: {
  tag: string;
  output: string;
  expectedCommit: string;
}): ResolvedRemoteTag;
