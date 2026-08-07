/**
 * What an `@fairux/sdk` release is, as one module a test can run.
 *
 * ## The policy this replaces, and the one it states
 *
 * The SDK release path was beta-only. Four gates spelled that invariant four ways, one of them a
 * bare `version.includes("-")`, so `0.1.0-rc.1` and the purely numeric `0.1.0-1` satisfied checks
 * named "beta-only" ([issue #68](https://github.com/toshtag/fairux-linter/issues/68)); the fix gave
 * them one meaning, `isBetaPrerelease`. That was the right invariant for a workflow whose release
 * notes said "beta" in three places and whose only channel was `next`. It is the wrong one for a
 * package that is about to have a stable release: `0.1.0` is not a beta, and a gate written for the
 * beta line would refuse it.
 *
 * So the SDK adopts the repository-wide channel policy the CLI already has, and the widening is
 * stated rather than left as a consequence:
 *
 * | Version | Channel | Accepted |
 * | --- | --- | --- |
 * | `0.1.0` | `latest` | yes — a stable release |
 * | `0.1.0-beta.4` | `next` | yes |
 * | `0.1.0-rc.1`, `0.2.0-alpha.1`, `0.1.0-1` | `next` | **yes**, which is new |
 * | `0.0.0-bootstrap.0` | — | no: the placeholder is not a release |
 * | `v0.1.0`, `0.1`, `1.0.0.0` | — | no: not SemVer |
 *
 * The middle row is the deliberate part. Dropping "beta" from the gate means an rc or an alpha is
 * now publishable, and it publishes to `next` — the same channel a beta uses, because `next` is
 * "the prerelease channel" and not "the beta channel". That is the CLI's policy verbatim, and
 * having one policy for two packages is the point; a second, narrower SDK rule would be a rule
 * nobody remembers when the first rc is tagged. What it is **not** is a loosening of what reaches
 * `latest`: only a version with no prerelease identifier at all publishes there, and
 * `scripts/release-channel-contract.mjs` refuses a prerelease on that channel on both sides of the
 * publish.
 *
 * The bootstrap rule survives unchanged, and is why this is a module rather than three shell lines.
 * An npm Trusted Publisher record is configured on a package's own settings page, so a name must be
 * created by a one-off manual publish before OIDC publishing can be configured for it. That
 * placeholder is a permanent version on the registry and it carries a prerelease identifier, so the
 * "prerelease is next" policy would route it onto the beta channel. A release workflow that
 * accepted it would publish a placeholder over `next`.
 *
 * Pure: no filesystem, no process, no network. The entrypoints beside this file supply those.
 */

import { packedTarballName } from "../../../scripts/release-bundle-contract.mjs";
import {
  BOOTSTRAP_DIST_TAG,
  BOOTSTRAP_VERSION,
  PRERELEASE_DIST_TAG,
  STABLE_DIST_TAG,
} from "../../../scripts/release-channel-contract.mjs";
import {
  classifyVersion,
  distTagFor,
  isBootstrapPrerelease,
} from "../../../scripts/release-version-contract.mjs";

/** The only package this contract describes. A release of anything else is a bug, not a variant. */
export const SDK_PACKAGE_NAME = "@fairux/sdk";

/** `sdk-v0.1.0`. The CLI uses `v`; the two workflows must never match each other's tags. */
export const SDK_TAG_PREFIX = "sdk-v";

/** The runbook every channel refusal points a reader at. */
export const SDK_RUNBOOK = "docs/maintainers/release-sdk.md";

// The channel constants are the repository's, not the SDK's. Aliased so this module reads as one
// package's contract while there is still only one definition of what `next` means.

/** The placeholder that reserves the name on npm. Never published by this workflow. */
export const SDK_BOOTSTRAP_VERSION = BOOTSTRAP_VERSION;

/** Where the placeholder lives, so it is reachable by name and on no channel a user installs. */
export const SDK_BOOTSTRAP_DIST_TAG = BOOTSTRAP_DIST_TAG;

/** The prerelease channel. Opting in stays explicit: `npm install @fairux/sdk@next`. */
export const SDK_PRERELEASE_DIST_TAG = PRERELEASE_DIST_TAG;

/** What a bare `npm install @fairux/sdk` resolves. Only a stable release moves it. */
export const SDK_STABLE_DIST_TAG = STABLE_DIST_TAG;

/** The checksum file `scripts/assemble-release-bundle.mjs` writes into every bundle. */
export const SDK_RELEASE_CHECKSUM_FILE = "release-sha256.txt";

export class SdkReleaseError extends Error {
  constructor(message) {
    super(message);
    this.name = "SdkReleaseError";
  }
}

/** The tag that releases a given version. Derived, so a caller cannot spell it a second way. */
export function sdkReleaseTag(version) {
  return `${SDK_TAG_PREFIX}${version}`;
}

/**
 * Resolve a git tag into the release it names, or refuse it.
 *
 * `on.push.tags: ["sdk-v*"]` is wider than this contract: it also matches `sdk-vnext` and
 * `sdk-v2-spike`. Those fail here, at the first gate, with a message that says which rule they
 * broke — rather than further down as a version mismatch against a manifest they were never about.
 *
 * @param {string} tag
 * @returns {{tag: string, version: string, prerelease: boolean, distTag: string}}
 */
export function resolveSdkRelease(tag) {
  if (typeof tag !== "string" || tag === "") {
    throw new SdkReleaseError("release tag is missing");
  }
  if (!tag.startsWith(SDK_TAG_PREFIX)) {
    throw new SdkReleaseError(`release tag must start with "${SDK_TAG_PREFIX}", got ${tag}`);
  }

  const version = tag.slice(SDK_TAG_PREFIX.length);
  const { valid, prerelease } = classifyVersion(version);
  if (!valid) {
    throw new SdkReleaseError(`release tag does not carry a valid SemVer version: ${tag}`);
  }

  // Before the dist-tag is derived, not after. `distTagFor` would map the placeholder to `next`,
  // and a check that ran afterwards would be comparing a channel this version may never reach.
  if (isBootstrapPrerelease(version)) {
    throw new SdkReleaseError(
      `${version} is a bootstrap placeholder and is published by hand, once, under the ` +
        `"${SDK_BOOTSTRAP_DIST_TAG}" dist-tag — never by this workflow. See ${SDK_RUNBOOK}.`,
    );
  }

  const distTag = distTagFor(version);
  if (distTag === null) {
    throw new SdkReleaseError(`no dist-tag policy applies to ${version}`);
  }

  return { tag, version, prerelease, distTag };
}

/** The tarball `pnpm pack` writes for a release, derived from the same helper the bundle uses. */
export function sdkTarballName(version) {
  return packedTarballName(SDK_PACKAGE_NAME, version);
}

/** `@fairux/sdk@0.1.0` — the exact registry specifier a release publishes and then verifies. */
export function sdkReleaseSpec(version) {
  return `${SDK_PACKAGE_NAME}@${version}`;
}
