/**
 * Which dist-tags `fairux` may carry, and what a release is allowed to move.
 *
 * `npm install fairux` with no tag resolves `latest`. `fairux` has never been published, so its
 * first real release creates the channel layout every later user inherits — and versions cannot be
 * unpublished after 72 hours. `@fairux/sdk` already carries the intended shape:
 *
 *     bootstrap: 0.0.0-bootstrap.0
 *     latest:    0.0.0-bootstrap.0
 *     next:      0.1.0-beta.2
 *
 * The CLI's policy is the same idea with one deliberate difference: `latest` is left **absent**
 * until the first stable release rather than parked on the placeholder. Absent and
 * pointing-at-a-placeholder both stop `npm install fairux` from resolving a beta, and absent does
 * not additionally advertise a version nobody should install.
 *
 * That makes `latest` load-bearing in a way a passing check cannot express by staying silent, so
 * this refuses a prerelease release when `latest` already exists. Publishing with an explicit
 * `--tag next` does not move `latest`, so a `latest` that exists at that point is a fact nobody in
 * this repository created deliberately — and the right response is to stop and ask the owner, not
 * to publish alongside it and not to delete it. The workflow never runs `npm dist-tag rm`.
 *
 * Pure: the caller reads the registry, this decides what the reading means.
 */

import { isBootstrapPrerelease } from "../../../scripts/release-version-contract.mjs";
import {
  CLI_BOOTSTRAP_DIST_TAG,
  CLI_PRERELEASE_DIST_TAG,
  CLI_STABLE_DIST_TAG,
} from "./cli-release-contract.mjs";

/** Tags this repository knows about. Anything else is reported rather than ignored. */
export const CLI_KNOWN_DIST_TAGS = Object.freeze([
  CLI_BOOTSTRAP_DIST_TAG,
  CLI_PRERELEASE_DIST_TAG,
  CLI_STABLE_DIST_TAG,
]);

/**
 * @param {object} input
 * @param {Record<string, string>} input.distTags  as `npm dist-tag ls` reports them
 * @param {string} input.version  the version this run published
 * @param {string} input.distTag  the channel it published to
 * @returns {string[]} failures; empty means the registry's tags match the policy
 */
export function auditCliDistTags({ distTags, version, distTag }) {
  const failures = [];
  if (typeof distTags !== "object" || distTags === null || Array.isArray(distTags)) {
    return ["dist-tags did not parse to an object"];
  }

  // The channel this run published to must name this run's version. Anything else means another
  // publish moved it between the write and this read, which is not a race to tolerate.
  if (distTags[distTag] !== version) {
    failures.push(
      `${distTag} must point at ${version}, registry says ${JSON.stringify(distTags[distTag])}`,
    );
  }

  if (distTag === CLI_PRERELEASE_DIST_TAG) {
    if (Object.hasOwn(distTags, CLI_STABLE_DIST_TAG)) {
      failures.push(
        `${CLI_STABLE_DIST_TAG} exists (${distTags[CLI_STABLE_DIST_TAG]}) but no stable version ` +
          "has been released; a plain `npm install fairux` would resolve it. This workflow does " +
          "not create, move, or remove it — see docs/cli-beta-release.md and ask the owner.",
      );
    }
  } else if (distTags[CLI_STABLE_DIST_TAG] !== version) {
    // A stable release is exactly the run that may set `latest`.
    failures.push(
      `${CLI_STABLE_DIST_TAG} must point at the stable release ${version}, registry says ` +
        JSON.stringify(distTags[CLI_STABLE_DIST_TAG]),
    );
  }

  // The placeholder's channel is not this workflow's to manage, but it must still not have become
  // a channel a user installs from.
  const bootstrap = distTags[CLI_BOOTSTRAP_DIST_TAG];
  if (bootstrap !== undefined && !isBootstrapPrerelease(bootstrap)) {
    failures.push(
      `${CLI_BOOTSTRAP_DIST_TAG} points at ${bootstrap}, which is not a bootstrap placeholder`,
    );
  }

  const unknown = Object.keys(distTags)
    .filter((tag) => !CLI_KNOWN_DIST_TAGS.includes(tag))
    .sort();
  if (unknown.length > 0) {
    failures.push(`unrecognised dist-tag(s) on fairux: ${unknown.join(", ")}`);
  }

  return failures;
}
