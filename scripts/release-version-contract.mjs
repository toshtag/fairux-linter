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

/**
 * The first prerelease identifier of a version, or `null` when it carries none.
 *
 * `0.1.0-beta.2` → `beta`; `0.1.0-rc.1+build` → `rc`; `1.0.0` → `null`. Build metadata never
 * participates: `1.0.0+beta` is a stable version carrying a build tag, not a beta.
 */
export function firstPrereleaseIdentifier(version) {
  const match = typeof version === "string" ? SEMVER.exec(version) : null;
  const prerelease = match?.[4];
  if (prerelease === undefined) return null;
  return prerelease.split(".")[0] ?? null;
}

/**
 * Whether a version is a *beta* prerelease, which is narrower than being a prerelease at all.
 *
 * P20's SDK gates were each named "beta-only" and each spelled the test differently — a
 * `prerelease` boolean in the workflow, the bundle assembler, and the bundle verifier, and a bare
 * `version.includes("-")` in the release check. All four accepted `0.1.0-alpha.1`, `0.1.0-rc.1`,
 * and the purely numeric `0.1.0-1`, so one release invariant had four meanings and none of them
 * was the one the name claims.
 *
 * Deliberately separate from `distTagFor`, which is the repository-wide "stable is latest,
 * prerelease is next" policy and governs the CLI as well — an rc on `next` is correct there. This
 * is the SDK's additional restriction, not a change to that policy.
 */
export function isBetaPrerelease(version) {
  return firstPrereleaseIdentifier(version) === "beta";
}

/** npm dist-tag for a version, under the usual "stable is latest, prerelease is next" policy. */
export function distTagFor(version) {
  const { valid, prerelease } = classifyVersion(version);
  if (!valid) return null;
  return prerelease ? "next" : "latest";
}
