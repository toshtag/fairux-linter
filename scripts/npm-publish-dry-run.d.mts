export declare const PUBLISH_CONFLICT_CODE: "EPUBLISHCONFLICT";

/**
 * Whether a failed `npm publish --dry-run` failed only because this exact name@version is already
 * on the registry — which is a fact about the registry's state, not about the tarball.
 *
 * `output` is npm's stdout and stderr together.
 */
export declare function isAlreadyPublished(input: { output: string; version: string }): boolean;

/**
 * Run `npm publish --dry-run`, tolerating only a conflict over this exact version.
 *
 * `run` is injected so the wiring is testable without a registry; its thrown error must carry npm's
 * output on `message`, `stdout`, or `stderr`.
 */
export declare function runPublishDryRun(input: {
  args: string[];
  version: string;
  run: (args: string[]) => string;
}): { stdout: string; alreadyPublished: false } | { stdout: null; alreadyPublished: true };
