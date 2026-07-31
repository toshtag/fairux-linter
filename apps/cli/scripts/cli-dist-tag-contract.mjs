/**
 * Which dist-tags `fairux` may carry, before and after a publish.
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
 * **Two audits, not one.** The first version of this module ran only after `npm publish`. A
 * `latest` that should not exist was therefore detected once `0.1.0-beta.1` had already been
 * written to the registry — and npm never lets a name/version pair be reused, so "refuse to publish
 * into an unexpected channel state" was a rule the workflow could state and not keep. The
 * pre-publish audit is the one that can still refuse; the post-publish audit is the one that
 * confirms the write landed where it was aimed. They ask different questions of the same map, so
 * they are different functions rather than one with a flag.
 *
 * Neither of them writes. A `latest` this repository did not create is an owner decision, and a
 * workflow that removed one would be destroying registry state to make its own check pass.
 *
 * Pure: the caller reads the registry, this decides what the reading means.
 */
import {
  CLI_BOOTSTRAP_DIST_TAG,
  CLI_BOOTSTRAP_VERSION,
  CLI_PRERELEASE_DIST_TAG,
  CLI_STABLE_DIST_TAG,
} from "./cli-release-contract.mjs";

/** Tags this repository knows about. Anything else is reported rather than ignored. */
export const CLI_KNOWN_DIST_TAGS = Object.freeze([
  CLI_BOOTSTRAP_DIST_TAG,
  CLI_PRERELEASE_DIST_TAG,
  CLI_STABLE_DIST_TAG,
]);

/** The two sides of `npm publish` this module audits. */
export const CLI_DIST_TAG_PHASES = Object.freeze(["before-publish", "after-publish"]);

function readDistTagMap(distTags) {
  if (typeof distTags !== "object" || distTags === null || Array.isArray(distTags)) {
    return null;
  }
  return distTags;
}

/**
 * Rules that hold on both sides of the publish, and are about the registry rather than this run.
 *
 * The placeholder is required here, in the shared half, so every phase and both release kinds get
 * it. It is the package's name-reservation history, and this contract does not delete it after a
 * stable release — a policy that retires it would be its own decision, not a silent consequence of
 * `latest` appearing.
 *
 * @param {Record<string, string>} distTags
 * @returns {string[]}
 */
function auditRegistryChannels(distTags) {
  const failures = [];

  // Required, and exact. Two separate failures, because they mean different things and because
  // folding them into one `!== undefined && !== expected` made absence pass: a `bootstrap` tag
  // deleted by hand left a package whose name-reservation history had been erased, and this audit
  // reported nothing. Presence is what proves the package was created the way the runbook says;
  // exactness is what proves nobody published a second placeholder.
  if (!Object.hasOwn(distTags, CLI_BOOTSTRAP_DIST_TAG)) {
    failures.push(
      `${CLI_BOOTSTRAP_DIST_TAG} is missing; docs/cli-beta-release.md requires it to point at ` +
        `${CLI_BOOTSTRAP_VERSION} before and after any real CLI release`,
    );
  } else {
    const bootstrap = distTags[CLI_BOOTSTRAP_DIST_TAG];
    if (bootstrap !== CLI_BOOTSTRAP_VERSION) {
      // `{ bootstrap: undefined }` lands here rather than in the branch above: the key exists, so
      // this is a tag pointing at nothing rather than a package with no placeholder.
      failures.push(
        `${CLI_BOOTSTRAP_DIST_TAG} points at ${bootstrap}, not the ${CLI_BOOTSTRAP_VERSION} ` +
          "placeholder docs/cli-beta-release.md creates",
      );
    }
  }

  const unknown = Object.keys(distTags)
    .filter((tag) => !CLI_KNOWN_DIST_TAGS.includes(tag))
    .sort();
  if (unknown.length > 0) {
    failures.push(`unrecognised dist-tag(s) on fairux: ${unknown.join(", ")}`);
  }

  return failures;
}

/** The message `latest` gets wherever it is refused, so a reader is sent to the same place. */
function latestMustNotExist(distTags) {
  return (
    `${CLI_STABLE_DIST_TAG} exists (${distTags[CLI_STABLE_DIST_TAG]}) but no stable version has ` +
    "been released; a plain `npm install fairux` would resolve it. This workflow does not create, " +
    "move, or remove it — see docs/cli-beta-release.md and ask the owner."
  );
}

/**
 * The gate that can still refuse. Runs after the publication plan and before `npm publish`.
 *
 * `publishNeeded` comes from the plan, and it changes what `next` is allowed to be. On a first
 * publish `next` must not exist yet; on a rerun of a release that already landed, `next` must
 * already name this version — the plan has separately proved the published digest matches, so the
 * only question left is whether the channel still points at it.
 *
 * @param {object} input
 * @param {unknown} input.distTags  as `npm view <pkg> dist-tags --json` reports them
 * @param {string} input.version  the version this run would publish
 * @param {string} input.distTag  the channel it would publish to
 * @param {boolean} input.publishNeeded  the publication plan's answer
 * @returns {string[]} failures; empty means the publish may proceed
 */
export function auditCliDistTagsBeforePublish({ distTags, version, distTag, publishNeeded }) {
  const map = readDistTagMap(distTags);
  if (map === null) return ["dist-tags did not parse to an object"];
  if (typeof publishNeeded !== "boolean") {
    return ["publishNeeded must be a boolean from the publication plan"];
  }

  const failures = auditRegistryChannels(map);

  if (distTag === CLI_PRERELEASE_DIST_TAG) {
    if (Object.hasOwn(map, CLI_STABLE_DIST_TAG)) failures.push(latestMustNotExist(map));

    const next = map[CLI_PRERELEASE_DIST_TAG];
    if (publishNeeded) {
      if (next !== undefined) {
        // Not fatal on its own terms — publishing would move `next` onto this version anyway — but
        // this contract is the first release of a package that has none, so a `next` that already
        // exists is a state nobody here produced. Stopping is cheap; the version is not.
        failures.push(
          `${CLI_PRERELEASE_DIST_TAG} already points at ${next}, but ${version} has not been ` +
            "published; this run did not create that tag",
        );
      }
    } else if (next !== version) {
      failures.push(
        `${version} is already on npm, so this is a rerun, but ${CLI_PRERELEASE_DIST_TAG} points ` +
          `at ${JSON.stringify(next)} rather than ${version}. This workflow does not move a ` +
          "dist-tag — see docs/cli-beta-release.md and ask the owner.",
      );
    }
    return failures;
  }

  // A stable release is the one run that may set `latest`. It may already hold an older version;
  // what it must not do is already name this one while the plan says a publish is needed.
  const latest = map[CLI_STABLE_DIST_TAG];
  if (publishNeeded && latest === version) {
    failures.push(
      `${CLI_STABLE_DIST_TAG} already points at ${version}, which has not been published`,
    );
  }
  if (!publishNeeded && latest !== version) {
    failures.push(
      `${version} is already on npm, but ${CLI_STABLE_DIST_TAG} points at ${JSON.stringify(latest)}`,
    );
  }
  return failures;
}

/**
 * The confirmation. Runs after the registry digest has been verified.
 *
 * Where the pre-publish audit asks "may this run write?", this asks "did the write land where it
 * was aimed?" — so the channel this run published to must now name exactly this version, whether
 * the publish happened or was skipped as an already-matching rerun.
 *
 * @param {object} input
 * @param {unknown} input.distTags
 * @param {string} input.version  the version this run published
 * @param {string} input.distTag  the channel it published to
 * @returns {string[]} failures; empty means the registry's tags match the policy
 */
export function auditCliDistTagsAfterPublish({ distTags, version, distTag }) {
  const map = readDistTagMap(distTags);
  if (map === null) return ["dist-tags did not parse to an object"];

  const failures = auditRegistryChannels(map);

  // Anything else means another publish moved it between the write and this read, which is not a
  // race to tolerate.
  if (map[distTag] !== version) {
    failures.push(
      `${distTag} must point at ${version}, registry says ${JSON.stringify(map[distTag])}`,
    );
  }

  if (distTag === CLI_PRERELEASE_DIST_TAG) {
    if (Object.hasOwn(map, CLI_STABLE_DIST_TAG)) failures.push(latestMustNotExist(map));
  } else if (map[CLI_STABLE_DIST_TAG] !== version) {
    failures.push(
      `${CLI_STABLE_DIST_TAG} must point at the stable release ${version}, registry says ` +
        JSON.stringify(map[CLI_STABLE_DIST_TAG]),
    );
  }

  return failures;
}
