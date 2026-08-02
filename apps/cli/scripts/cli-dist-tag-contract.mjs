/**
 * Which dist-tags `fairux` may carry, before and after a publish.
 *
 * `npm install fairux` with no tag resolves `latest`. `fairux` has never been published, so its
 * first real release creates the channel layout every later user inherits — and a published
 * name/version can never be reused, not even after an unpublish. `@fairux/sdk` already carries the
 * intended shape:
 *
 *     bootstrap: 0.0.0-bootstrap.0
 *     latest:    0.0.0-bootstrap.0
 *     next:      0.1.0-beta.2
 *
 * The CLI's policy is the same idea with one deliberate difference: before the first stable
 * release `latest` is left **absent** rather than parked on the placeholder. Absent and
 * pointing-at-a-placeholder both stop `npm install fairux` from resolving a beta, and absent does
 * not additionally advertise a version nobody should install.
 *
 * **A channel may advance; it must not go backwards.** The first version of this module stated the
 * absence rules directly — `next` must not exist, `latest` must not exist — which is true of the
 * first beta of a package that has never been released and false of every release after it.
 * `publish-cli.yml` is a generic release path, so `0.1.0-beta.2` was refused for finding
 * `0.1.0-beta.1` on `next`, and every prerelease after the first stable was refused for finding
 * `latest` at all. The rules are precedence comparisons now: a channel naming something older is
 * the normal case, and naming the same version, something newer, or something of the wrong kind is
 * what stops a release.
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
  classifyVersion,
  compareVersions,
  isBootstrapPrerelease,
} from "../../../scripts/release-version-contract.mjs";
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
      `${CLI_BOOTSTRAP_DIST_TAG} is missing; docs/maintainers/release-cli.md requires it to point at ` +
        `${CLI_BOOTSTRAP_VERSION} before and after any real CLI release`,
    );
  } else {
    const bootstrap = distTags[CLI_BOOTSTRAP_DIST_TAG];
    if (bootstrap !== CLI_BOOTSTRAP_VERSION) {
      // `{ bootstrap: undefined }` lands here rather than in the branch above: the key exists, so
      // this is a tag pointing at nothing rather than a package with no placeholder.
      failures.push(
        `${CLI_BOOTSTRAP_DIST_TAG} points at ${bootstrap}, not the ${CLI_BOOTSTRAP_VERSION} ` +
          "placeholder docs/maintainers/release-cli.md creates",
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

/** Where every channel refusal sends a reader, since the fix is never this workflow's to make. */
const ASK_THE_OWNER =
  "This workflow does not create, move, or remove a dist-tag — see docs/maintainers/release-cli.md and " +
  "ask the owner.";

/**
 * A channel may advance and must not go backwards.
 *
 * The first version of this contract said `next` and `latest` must not exist at all. That is true
 * of the *first* beta of a package that has never been released, and it is the release this branch
 * was written for — but `publish-cli.yml` is a generic release path, so encoding it made every
 * later release impossible: `0.1.0-beta.2` was refused because `next` named `0.1.0-beta.1`, and
 * every prerelease after the first stable was refused because `latest` existed.
 *
 * The real invariant is precedence. A channel already naming something *older* than the version
 * being published is the normal case; naming the same version, something newer, or something of
 * the wrong kind is what a release must stop for.
 *
 * @param {string} tag  the channel being inspected
 * @param {string | undefined} tagged  what the registry says it names
 * @param {string} target  the version this run is publishing
 * @param {{mustBeStable: boolean}} options
 * @returns {string | null} why it is refused, or `null`
 */
function olderChannelFailure(tag, tagged, target, { mustBeStable }) {
  if (tagged === undefined) return null;

  const { valid, prerelease } = classifyVersion(tagged);
  if (!valid)
    return `${tag} points at ${JSON.stringify(tagged)}, which is not a version. ${ASK_THE_OWNER}`;
  if (isBootstrapPrerelease(tagged)) {
    return `${tag} points at the ${tagged} placeholder, which is not a release. ${ASK_THE_OWNER}`;
  }
  if (mustBeStable && prerelease) {
    return `${tag} points at the prerelease ${tagged}; this channel carries stable releases. ${ASK_THE_OWNER}`;
  }
  if (!mustBeStable && !prerelease) {
    return `${tag} points at the stable release ${tagged}; this channel carries prereleases. ${ASK_THE_OWNER}`;
  }

  const order = compareVersions(tagged, target);
  if (order === 0) {
    return `${tag} already points at ${target}, which this run has not published. ${ASK_THE_OWNER}`;
  }
  if (order === 1) {
    // Publishing would move the channel onto an older version than the one users already resolve.
    return `${tag} points at ${tagged}, which is newer than ${target}; publishing would move the channel backwards. ${ASK_THE_OWNER}`;
  }
  return null;
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

  const next = map[CLI_PRERELEASE_DIST_TAG];
  const latest = map[CLI_STABLE_DIST_TAG];

  if (distTag === CLI_PRERELEASE_DIST_TAG) {
    // `latest` is not this run's channel, but publishing a prerelease that a stable release has
    // already overtaken would put `next` behind `latest` — a user on `next` would be older than a
    // user on the default. Absent satisfies this, which is the state before the first stable.
    const latestFailure = olderChannelFailure(CLI_STABLE_DIST_TAG, latest, version, {
      mustBeStable: true,
    });
    if (latestFailure) failures.push(latestFailure);

    if (publishNeeded) {
      const nextFailure = olderChannelFailure(CLI_PRERELEASE_DIST_TAG, next, version, {
        mustBeStable: false,
      });
      if (nextFailure) failures.push(nextFailure);
    } else if (next !== version) {
      // A rerun of a release that landed. The plan has proved the published digest matches, so the
      // only question left is whether the channel still points at it.
      failures.push(
        `${version} is already on npm, so this is a rerun, but ${CLI_PRERELEASE_DIST_TAG} points ` +
          `at ${JSON.stringify(next)} rather than ${version}. ${ASK_THE_OWNER}`,
      );
    }
    return failures;
  }

  // A stable release is the one run that may move `latest`. `next` is left alone: a stable release
  // does not retract the beta channel, and this workflow moves no tag it did not publish to.
  if (publishNeeded) {
    const latestFailure = olderChannelFailure(CLI_STABLE_DIST_TAG, latest, version, {
      mustBeStable: true,
    });
    if (latestFailure) failures.push(latestFailure);
  } else if (latest !== version) {
    failures.push(
      `${version} is already on npm, so this is a rerun, but ${CLI_STABLE_DIST_TAG} points at ` +
        `${JSON.stringify(latest)} rather than ${version}. ${ASK_THE_OWNER}`,
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
    // Unchanged from the pre-publish rule: `latest` must still be absent or an older stable
    // release. A `latest` that moved past this prerelease *during* the publish is the same defect
    // arriving a few seconds later.
    const latestFailure = olderChannelFailure(
      CLI_STABLE_DIST_TAG,
      map[CLI_STABLE_DIST_TAG],
      version,
      {
        mustBeStable: true,
      },
    );
    if (latestFailure) failures.push(latestFailure);
  } else if (map[CLI_STABLE_DIST_TAG] !== version) {
    failures.push(
      `${CLI_STABLE_DIST_TAG} must point at the stable release ${version}, registry says ` +
        JSON.stringify(map[CLI_STABLE_DIST_TAG]),
    );
  }

  return failures;
}
