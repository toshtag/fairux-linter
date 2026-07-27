/**
 * Version policy for the release workflows — one implementation, shared.
 *
 * The prerelease test used to be `/-[a-zA-Z]/`, repeated in a few places. It calls `1.0.0-1` a
 * stable release, which is wrong: SemVer prerelease identifiers may be numeric, and the CLI
 * workflow would have put it on `latest`.
 */

/** SemVer 2.0.0, anchored. Groups: major.minor.patch, prerelease, build. */
const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

/**
 * @returns {{ valid: boolean, prerelease: boolean }}
 */
export function classifyVersion(version) {
  const match = typeof version === "string" ? SEMVER.exec(version) : null;
  if (!match) return { valid: false, prerelease: false };
  return { valid: true, prerelease: match[4] !== undefined };
}

/** npm dist-tag for a version, under the usual "stable is latest, prerelease is next" policy. */
export function distTagFor(version) {
  const { valid, prerelease } = classifyVersion(version);
  if (!valid) return null;
  return prerelease ? "next" : "latest";
}
