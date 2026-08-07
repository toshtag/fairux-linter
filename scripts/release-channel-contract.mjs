/**
 * Which dist-tags a released package may carry, before and after a publish.
 *
 * `npm install <pkg>` with no tag resolves `latest`. A published name/version can never be reused,
 * not even after an unpublish, so the channel layout the first real release inherits is one every
 * later user inherits too. Both packages this repository publishes sit at the same shape until
 * their first stable release:
 *
 *     bootstrap: 0.0.0-bootstrap.0
 *     latest:    0.0.0-bootstrap.0
 *     next:      <the newest prerelease>
 *
 * `latest` on the placeholder is not a state anybody chose. npm sets `latest` to a package's first
 * published version whatever `--tag` says — `--tag bootstrap` does not stop the *first* version of
 * a package becoming the default — and `npm dist-tag rm <pkg> latest` is refused with HTTP 400. An
 * earlier version of this policy required `latest` to be absent before the first stable release,
 * and a preflight duly refused a beta over a state no owner could reach. The placeholder is
 * deprecated instead, so nobody installs it in passing. What `latest` still may not be is a
 * prerelease of any kind: the first stable release moves it, and nothing else does.
 *
 * The asymmetry between `latest` and `next` mirrors which tag npm sets by itself. npm creates
 * `latest`; it has never created `next`, so a `next` naming the placeholder is a tag somebody moved
 * by hand into a channel a release workflow owns, and stays a refusal.
 *
 * **A channel may advance; it must not go backwards.** Stating the absence rules directly — `next`
 * must not exist, `latest` must not exist — is true of the first release of a package that has
 * never been published and false of every release after it. The rules are precedence comparisons:
 * a channel naming something older is the normal case, and naming the same version, something
 * newer, or something of the wrong kind is what stops a release.
 *
 * **Two audits, not one.** Running only after `npm publish` means an unexpected channel state is
 * detected once the version has already been written to the registry — so "refuse to publish into
 * an unexpected channel state" becomes a rule a workflow can state and not keep. The pre-publish
 * audit is the one that can still refuse; the post-publish audit is the one that confirms the write
 * landed where it was aimed. They ask different questions of the same map, so they are different
 * functions rather than one with a flag.
 *
 * Neither of them writes. A dist-tag a workflow did not publish to is the owner's, and one that
 * removed or moved one would be rewriting registry state to make its own check pass — which is how
 * the unsatisfiable `latest` rule above would have been "fixed" if repair had been on the table.
 *
 * **One implementation, two packages.** This began as `apps/cli/scripts/cli-dist-tag-contract.mjs`,
 * written when only the CLI had a stable channel policy and the SDK's release path was beta-only.
 * Giving the SDK the same guarantees by copying it would have produced two channel policies that
 * agree until one of them is fixed. The package name and the runbook a refusal points at are the
 * only things that differ, so they are parameters and everything else is shared.
 *
 * Pure: the caller reads the registry, this decides what the reading means.
 */
import {
  classifyVersion,
  compareVersions,
  isBootstrapPrerelease,
} from "./release-version-contract.mjs";

/** Where a placeholder lives, so it is reachable by name and on no channel a user installs. */
export const BOOTSTRAP_DIST_TAG = "bootstrap";

/** The prerelease channel. Opting in stays explicit: `npm install <pkg>@next`. */
export const PRERELEASE_DIST_TAG = "next";

/** What a bare `npm install <pkg>` resolves. Only a stable release moves it. */
export const STABLE_DIST_TAG = "latest";

/** The placeholder that reserves a name on npm. Never published by a release workflow. */
export const BOOTSTRAP_VERSION = "0.0.0-bootstrap.0";

/** Tags this repository knows about. Anything else is reported rather than ignored. */
export const KNOWN_DIST_TAGS = Object.freeze([
  BOOTSTRAP_DIST_TAG,
  PRERELEASE_DIST_TAG,
  STABLE_DIST_TAG,
]);

/** The two sides of `npm publish` these audits describe. */
export const DIST_TAG_PHASES = Object.freeze(["before-publish", "after-publish"]);

function readDistTagMap(distTags) {
  if (typeof distTags !== "object" || distTags === null || Array.isArray(distTags)) {
    return null;
  }
  return distTags;
}

/**
 * Build the two audits for one package.
 *
 * @param {{packageName: string, runbook: string, bootstrapVersion?: string}} binding
 */
export function createDistTagContract({
  packageName,
  runbook,
  bootstrapVersion = BOOTSTRAP_VERSION,
}) {
  /** Where every channel refusal sends a reader, since the fix is never a workflow's to make. */
  const askTheOwner = `This workflow does not create, move, or remove a dist-tag — see ${runbook} and ask the owner.`;

  /**
   * Rules that hold on both sides of the publish, and are about the registry rather than this run.
   *
   * The placeholder is required here, in the shared half, so every phase gets it. It is the
   * package's name-reservation history, and this contract does not delete it after a stable
   * release — a policy that retires it would be its own decision, not a silent consequence of
   * `latest` moving.
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
    if (!Object.hasOwn(distTags, BOOTSTRAP_DIST_TAG)) {
      failures.push(
        `${BOOTSTRAP_DIST_TAG} is missing; ${runbook} requires it to point at ` +
          `${bootstrapVersion} before and after any real release`,
      );
    } else {
      const bootstrap = distTags[BOOTSTRAP_DIST_TAG];
      if (bootstrap !== bootstrapVersion) {
        // `{ bootstrap: undefined }` lands here rather than in the branch above: the key exists, so
        // this is a tag pointing at nothing rather than a package with no placeholder.
        failures.push(
          `${BOOTSTRAP_DIST_TAG} points at ${bootstrap}, not the ${bootstrapVersion} ` +
            `placeholder ${runbook} creates`,
        );
      }
    }

    const unknown = Object.keys(distTags)
      .filter((tag) => !KNOWN_DIST_TAGS.includes(tag))
      .sort();
    if (unknown.length > 0) {
      failures.push(`unrecognised dist-tag(s) on ${packageName}: ${unknown.join(", ")}`);
    }

    return failures;
  }

  /**
   * A channel may advance and must not go backwards.
   *
   * @param {string} tag  the channel being inspected
   * @param {string | undefined} tagged  what the registry says it names
   * @param {string} target  the version this run is publishing
   * @param {{mustBeStable: boolean, placeholderAllowed?: boolean}} options
   *   `placeholderAllowed` is for `latest` and only for `latest`: npm sets it to a package's first
   *   published version and refuses to remove it, so the placeholder sitting there is the state the
   *   runbook produces rather than one somebody has to explain.
   * @returns {string | null} why it is refused, or `null`
   */
  function olderChannelFailure(tag, tagged, target, { mustBeStable, placeholderAllowed = false }) {
    if (tagged === undefined) return null;

    const { valid, prerelease } = classifyVersion(tagged);
    if (!valid)
      return `${tag} points at ${JSON.stringify(tagged)}, which is not a version. ${askTheOwner}`;
    if (isBootstrapPrerelease(tagged)) {
      // Checked before the stable/prerelease split below, because the placeholder is a prerelease
      // and would otherwise be refused by the rule that keeps prereleases off `latest`. It is not a
      // release and it does not participate in precedence: it sorts below every real version, so a
      // run that may move this channel is free to move it, and one that may not leaves it where npm
      // put it.
      if (placeholderAllowed) return null;
      return `${tag} points at the ${tagged} placeholder, which is not a release. ${askTheOwner}`;
    }
    if (mustBeStable && prerelease) {
      return `${tag} points at the prerelease ${tagged}; this channel carries stable releases. ${askTheOwner}`;
    }
    if (!mustBeStable && !prerelease) {
      return `${tag} points at the stable release ${tagged}; this channel carries prereleases. ${askTheOwner}`;
    }

    const order = compareVersions(tagged, target);
    if (order === 0) {
      return `${tag} already points at ${target}, which this run has not published. ${askTheOwner}`;
    }
    if (order === 1) {
      // Publishing would move the channel onto an older version than the one users already resolve.
      return `${tag} points at ${tagged}, which is newer than ${target}; publishing would move the channel backwards. ${askTheOwner}`;
    }
    return null;
  }

  /**
   * The gate that can still refuse. Runs after the publication plan and before `npm publish`.
   *
   * `publishNeeded` comes from the plan, and it changes what the release's own channel is allowed
   * to be. On a first publish it must not already name this version; on a rerun of a release that
   * already landed, it must — the plan has separately proved the published digest matches, so the
   * only question left is whether the channel still points at it.
   *
   * @param {object} input
   * @param {unknown} input.distTags  as `npm view <pkg> dist-tags --json` reports them
   * @param {string} input.version  the version this run would publish
   * @param {string} input.distTag  the channel it would publish to
   * @param {boolean} input.publishNeeded  the publication plan's answer
   * @returns {string[]} failures; empty means the publish may proceed
   */
  function auditBeforePublish({ distTags, version, distTag, publishNeeded }) {
    const map = readDistTagMap(distTags);
    if (map === null) return ["dist-tags did not parse to an object"];
    if (typeof publishNeeded !== "boolean") {
      return ["publishNeeded must be a boolean from the publication plan"];
    }

    const failures = auditRegistryChannels(map);

    const next = map[PRERELEASE_DIST_TAG];
    const latest = map[STABLE_DIST_TAG];

    if (distTag === PRERELEASE_DIST_TAG) {
      // `latest` is not this run's channel, but publishing a prerelease that a stable release has
      // already overtaken would put `next` behind `latest` — a user on `next` would be older than a
      // user on the default. Absent satisfies this, which is the state before the first stable.
      const latestFailure = olderChannelFailure(STABLE_DIST_TAG, latest, version, {
        mustBeStable: true,
        placeholderAllowed: true,
      });
      if (latestFailure) failures.push(latestFailure);

      if (publishNeeded) {
        const nextFailure = olderChannelFailure(PRERELEASE_DIST_TAG, next, version, {
          mustBeStable: false,
        });
        if (nextFailure) failures.push(nextFailure);
      } else if (next !== version) {
        // A rerun of a release that landed. The plan has proved the published digest matches, so
        // the only question left is whether the channel still points at it.
        failures.push(
          `${version} is already on npm, so this is a rerun, but ${PRERELEASE_DIST_TAG} points ` +
            `at ${JSON.stringify(next)} rather than ${version}. ${askTheOwner}`,
        );
      }
      return failures;
    }

    // A stable release is the one run that may move `latest`. `next` is left alone: a stable
    // release does not retract the prerelease channel, and no workflow moves a tag it did not
    // publish to.
    if (publishNeeded) {
      // The one run that may move `latest`, and therefore the one that may move it off the
      // placeholder — which is where npm parked it and where it has stayed through every
      // prerelease.
      const latestFailure = olderChannelFailure(STABLE_DIST_TAG, latest, version, {
        mustBeStable: true,
        placeholderAllowed: true,
      });
      if (latestFailure) failures.push(latestFailure);
    } else if (latest !== version) {
      failures.push(
        `${version} is already on npm, so this is a rerun, but ${STABLE_DIST_TAG} points at ` +
          `${JSON.stringify(latest)} rather than ${version}. ${askTheOwner}`,
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
  function auditAfterPublish({ distTags, version, distTag }) {
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

    if (distTag === PRERELEASE_DIST_TAG) {
      // Unchanged from the pre-publish rule: `latest` must still be the placeholder, absent, or an
      // older stable release. A `latest` that moved onto this prerelease *during* the publish is
      // the same defect arriving a few seconds later.
      const latestFailure = olderChannelFailure(STABLE_DIST_TAG, map[STABLE_DIST_TAG], version, {
        mustBeStable: true,
        placeholderAllowed: true,
      });
      if (latestFailure) failures.push(latestFailure);
    } else if (map[STABLE_DIST_TAG] !== version) {
      failures.push(
        `${STABLE_DIST_TAG} must point at the stable release ${version}, registry says ` +
          JSON.stringify(map[STABLE_DIST_TAG]),
      );
    }

    return failures;
  }

  return { auditBeforePublish, auditAfterPublish };
}

/**
 * Compare the dist-tags before and after publishing, when a before-reading was taken.
 *
 * The audits above are what must hold; this is what must not have *changed*. A run that moved a tag
 * it was never asked to move is a run that made a decision on someone's behalf, and the difference
 * is only visible against a prior reading. Current values cannot express it: a run where `latest`
 * moved from the placeholder to some unrelated release passes every current-value check, because
 * neither value is the version being published.
 *
 * Not package-specific, so it takes no binding.
 *
 * @param {{before: unknown, after: unknown, channel: string}} input
 * @returns {string[]}
 */
export function auditUnchangedDistTags({ before, after, channel }) {
  if (typeof before !== "object" || before === null) return [];
  const previous = /** @type {Record<string, unknown>} */ (before);
  const current = /** @type {Record<string, unknown>} */ (after ?? {});
  const failures = [];

  for (const [tag, value] of Object.entries(previous)) {
    if (tag === channel) continue;
    if (current[tag] !== value) {
      failures.push(
        `dist-tag ${tag} moved from ${JSON.stringify(value)} to ${JSON.stringify(current[tag])}; ` +
          `this release was only asked to move ${channel}`,
      );
    }
  }
  for (const tag of Object.keys(current)) {
    if (!(tag in previous)) {
      failures.push(`dist-tag ${tag} appeared, and this release did not add it`);
    }
  }
  return failures;
}
