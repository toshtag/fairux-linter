export declare const PUBLISH_CONFLICT_CODE: "EPUBLISHCONFLICT";

/**
 * Whether a failed `npm publish --dry-run` failed only because this exact name@version is already
 * on the registry — which is a fact about the registry's state, not about the tarball.
 *
 * `output` is npm's stdout and stderr together.
 */
export declare function isAlreadyPublished(input: { output: string; version: string }): boolean;
