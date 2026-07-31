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

/**
 * Whether a version is the placeholder that reserves a package name, rather than a release.
 *
 * `fairux` did not exist on npm, and an npm Trusted Publisher record is configured on a package's
 * own settings page — so the name has to be created by a one-off manual publish before OIDC
 * publishing can be configured for it. That placeholder is a permanent version on the registry and
 * it carries a prerelease identifier, so `distTagFor` would route it to `next`: the beta channel.
 *
 * Separate from `isBetaPrerelease` because it answers the opposite question. That one asks whether
 * a version is eligible for a workflow; this asks whether it is a release at all.
 */
export function isBootstrapPrerelease(version) {
  return firstPrereleaseIdentifier(version) === "bootstrap";
}

/** Whether an identifier is the numeric kind SemVer compares as a number. */
const NUMERIC_IDENTIFIER = /^(?:0|[1-9]\d*)$/;

/**
 * SemVer 2.0.0 precedence, as `-1 | 0 | 1`, or `null` when either version is not valid SemVer.
 *
 * A dist-tag is a channel, and a channel may advance but must not go backwards — which is a
 * comparison, not an equality. Without one, the CLI's channel policy could only be written for a
 * package that had never been released: "`next` must not exist, `latest` must not exist" made the
 * first beta correct and every release after it impossible.
 *
 * Two parts of §11 are easy to get wrong and both matter here. A version with no prerelease
 * identifiers outranks one with them at the same core version, so `1.0.0` is *newer* than
 * `1.0.0-beta.1` — which is why "is `latest` older than the beta I am publishing?" is not answered
 * by comparing the cores. And identifiers are compared by kind before value: numeric ones compare
 * numerically and rank below non-numeric ones, so `1.0.0-2` precedes `1.0.0-alpha`.
 *
 * Build metadata is ignored, per §10: `1.0.0+one` and `1.0.0+two` are the same version.
 */
export function compareVersions(left, right) {
  const a = typeof left === "string" ? SEMVER.exec(left) : null;
  const b = typeof right === "string" ? SEMVER.exec(right) : null;
  if (!a || !b) return null;

  for (let index = 1; index <= 3; index += 1) {
    const difference = Number(a[index]) - Number(b[index]);
    if (difference !== 0) return difference < 0 ? -1 : 1;
  }

  const leftPre = a[4];
  const rightPre = b[4];
  if (leftPre === undefined && rightPre === undefined) return 0;
  // Having a prerelease is what makes a version *lower* at the same core.
  if (leftPre === undefined) return 1;
  if (rightPre === undefined) return -1;

  const leftIds = leftPre.split(".");
  const rightIds = rightPre.split(".");
  for (let index = 0; index < Math.min(leftIds.length, rightIds.length); index += 1) {
    const one = /** @type {string} */ (leftIds[index]);
    const other = /** @type {string} */ (rightIds[index]);
    if (one === other) continue;

    const oneNumeric = NUMERIC_IDENTIFIER.test(one);
    const otherNumeric = NUMERIC_IDENTIFIER.test(other);
    if (oneNumeric && otherNumeric) return Number(one) < Number(other) ? -1 : 1;
    // Kind before value: a numeric identifier always has lower precedence than a non-numeric one.
    if (oneNumeric !== otherNumeric) return oneNumeric ? -1 : 1;
    return one < other ? -1 : 1;
  }
  // A common prefix leaves the longer identifier list higher.
  if (leftIds.length === rightIds.length) return 0;
  return leftIds.length < rightIds.length ? -1 : 1;
}

/** npm dist-tag for a version, under the usual "stable is latest, prerelease is next" policy. */
export function distTagFor(version) {
  const { valid, prerelease } = classifyVersion(version);
  if (!valid) return null;
  return prerelease ? "next" : "latest";
}
