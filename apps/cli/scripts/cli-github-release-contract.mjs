/**
 * What an existing GitHub Release must already be, before this workflow edits it.
 *
 * The create-or-repair step claimed to "create or repair" a Release, and the repair half was
 * broader than what it could actually do. `gh release edit --latest` does not clear a `prerelease`
 * flag: a Release created — by hand, or by an earlier run of a workflow that classified it
 * differently — as a prerelease stays a prerelease, and the edit either fails or succeeds while
 * leaving the classification wrong. Either way the run would have reported a repaired Release.
 *
 * So repair is scoped to what it can honestly do: notes, title, and assets on a Release that is
 * *already* classified the way this release is. Anything else stops and names the owner. Silently
 * reclassifying is worse than failing — a Release's prerelease flag is what decides whether GitHub
 * shows it as the current one, and a workflow that flips it without being asked is making a
 * publication decision.
 *
 * Deleting and recreating is not the alternative. That drops download counts and reaction history
 * on something already public, to fix a classification a human can change in one click.
 *
 * Pure: the caller reads the Release, this decides what the reading means.
 */

/** The fields `gh release view --json` must return for this contract to have an opinion. */
export const CLI_RELEASE_VIEW_FIELDS = Object.freeze(["tagName", "isDraft", "isPrerelease"]);

/**
 * @param {object} input
 * @param {string} input.expectedTag
 * @param {boolean} input.expectedPrerelease  derived from the version being released
 * @param {unknown} input.release  parsed `gh release view --json tagName,isDraft,isPrerelease`
 * @returns {string[]} failures; empty means the Release may be repaired in place
 */
export function auditExistingCliRelease({ expectedTag, expectedPrerelease, release }) {
  if (typeof release !== "object" || release === null || Array.isArray(release)) {
    return ["gh release view did not return an object"];
  }

  const failures = [];
  const { tagName, isDraft, isPrerelease } = release;

  // Typed before compared. A missing field reads as `undefined`, and `undefined !== true` would
  // have quietly classified an unknown Release as a published stable one.
  if (typeof tagName !== "string" || tagName === "") {
    failures.push(`existing Release has no tagName: ${JSON.stringify(tagName)}`);
  } else if (tagName !== expectedTag) {
    failures.push(
      `existing Release is on tag ${tagName}, not ${expectedTag}; this run would edit a Release ` +
        "for a different version",
    );
  }

  if (typeof isDraft !== "boolean") {
    failures.push(`existing Release has no isDraft flag: ${JSON.stringify(isDraft)}`);
  } else if (isDraft) {
    // A draft is not published, so "repairing" one would publish it as a side effect of a rerun.
    failures.push(
      `existing Release ${expectedTag} is a draft. This workflow does not publish a draft; ` +
        "review it on GitHub and either publish or delete it. See docs/maintainers/release-cli.md.",
    );
  }

  if (typeof isPrerelease !== "boolean") {
    failures.push(`existing Release has no isPrerelease flag: ${JSON.stringify(isPrerelease)}`);
  } else if (isPrerelease !== expectedPrerelease) {
    failures.push(
      `existing Release ${expectedTag} is marked ${isPrerelease ? "prerelease" : "latest"} but ` +
        `${expectedTag} is a ${expectedPrerelease ? "prerelease" : "stable release"}. This ` +
        "workflow repairs notes and assets, not classification — `gh release edit` cannot clear a " +
        "prerelease flag, and flipping it would be a publication decision. Fix it on GitHub and " +
        "re-run. See docs/maintainers/release-cli.md.",
    );
  }

  return failures;
}
