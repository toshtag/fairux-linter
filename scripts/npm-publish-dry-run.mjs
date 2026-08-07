/**
 * What `npm publish --dry-run` means once the version it names is already on the registry.
 *
 * The dry run is the packed smokes' last check: the exact command the release path runs has to
 * accept the exact tarball that will be published. It is not offline. npm resolves the package on
 * the registry first, so from the moment a version is published, that command answers
 *
 *     npm error code EPUBLISHCONFLICT
 *     npm error You cannot publish over the previously published versions: 0.1.0.
 *
 * for every subsequent run against that version — and `main` carries the released version between
 * a release and the next bump. `@fairux/sdk@0.1.0` and `fairux@0.1.0` went to the registry and the
 * next push to `main` turned the release-contract lane red in `pack-smoke`, `sdk-pack-smoke`, and
 * both release preflights.
 *
 * Half the matrix went red, which is worth naming because it is the part that looks like a flake.
 * What was measured: the conflict reproduces locally on the same npm that passed in CI, and whether
 * a given invocation hits it depends on the working directory it runs in and on what npm has
 * cached. Why those two cells differed on that run was not established, and it does not need to be —
 * a check whose colour depends on either is not reporting anything about the artifact.
 *
 * **What is a pass, narrowly.** npm validates the tarball — name, version, file list, sizes,
 * lifecycle scripts — *before* it asks the registry to accept it, so a conflict is a fact about the
 * registry's state and not about the artifact. What the smoke is asking is "would this command
 * accept these bytes", and the answer is still yes.
 *
 * So this accepts exactly one refusal: `EPUBLISHCONFLICT` naming **this** package and version.
 * A conflict over a different version, a different package, or any other npm error is still a
 * failure — the point of the check is that the command accepts the artifact, and everything except
 * "that exact version already exists" would mean it does not.
 *
 * Not `--dry-run` against a fake version, and not skipping the check after a release. The first
 * would validate a tarball nobody publishes; the second would delete the smoke for exactly the
 * window in which the released bytes are the ones in the tree.
 */

/** npm's own error code for "this name@version is already on the registry". */
export const PUBLISH_CONFLICT_CODE = "EPUBLISHCONFLICT";

/**
 * Whether a failed `npm publish --dry-run` failed *only* because this version is already published.
 *
 * `output` is everything npm wrote — stdout and stderr together. npm reports the conflict in both,
 * in `--json` mode and out of it, and which stream carries it has changed between versions; reading
 * the pair avoids depending on that.
 *
 * @param {{output: string, name: string, version: string}} input
 * @returns {boolean}
 */
export function isAlreadyPublished({ output, name, version }) {
  if (typeof output !== "string" || output === "") return false;
  if (!output.includes(PUBLISH_CONFLICT_CODE) && !output.includes("cannot publish over")) {
    return false;
  }
  // The version npm named, not merely "a conflict happened". A run that conflicted over some other
  // version is a run whose tarball is not the one this smoke packed.
  const conflicted = new RegExp(
    `previously published versions?: ${version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`,
  ).test(output);
  if (!conflicted) return false;
  // And this package. `npm publish` prints the spec it was refused for; a mismatch means the
  // tarball in the working directory is not the one being reasoned about.
  return output.includes(name);
}
