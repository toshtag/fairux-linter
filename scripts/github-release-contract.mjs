/**
 * What an existing GitHub Release must already be, before a publish workflow edits it.
 *
 * A create-or-repair step that claims to "create or repair" a Release makes a promise the repair
 * half cannot keep. `gh release edit --latest` does not clear a `prerelease` flag: a Release created
 * — by hand, or by an earlier run of a workflow that classified it differently — as a prerelease
 * stays a prerelease, and the edit either fails or succeeds while leaving the classification wrong.
 * Either way the run reports a repaired Release.
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
 * **Why this is shared.** It was `apps/cli/scripts/cli-github-release-contract.mjs`, written when
 * only the CLI could produce a stable Release; the SDK's workflow passed `--prerelease`
 * unconditionally, which was correct for a beta-only path and is the bug the moment a stable SDK
 * version is tagged. Both workflows classify a Release now, so both need the refusal, and two
 * copies of it would be two rules that agree until one is fixed. The runbook a refusal points at is
 * the only thing that differs.
 *
 * Pure: the caller reads the Release, this decides what the reading means.
 */

/** The fields `gh release view --json` must return for this contract to have an opinion. */
export const RELEASE_VIEW_FIELDS = Object.freeze(["tagName", "isDraft", "isPrerelease"]);

/**
 * Bind the contract to the runbook its refusals send a reader to.
 *
 * @param {{runbook: string}} binding
 */
export function createGithubReleaseContract({ runbook }) {
  /**
   * @param {object} input
   * @param {string} input.expectedTag
   * @param {boolean} input.expectedPrerelease  derived from the version being released
   * @param {unknown} input.release  parsed `gh release view --json tagName,isDraft,isPrerelease`
   * @returns {string[]} failures; empty means the Release may be repaired in place
   */
  function auditExistingRelease({ expectedTag, expectedPrerelease, release }) {
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
          `review it on GitHub and either publish or delete it. See ${runbook}.`,
      );
    }

    if (typeof isPrerelease !== "boolean") {
      failures.push(`existing Release has no isPrerelease flag: ${JSON.stringify(isPrerelease)}`);
    } else if (isPrerelease !== expectedPrerelease) {
      failures.push(
        `existing Release ${expectedTag} is marked ${isPrerelease ? "prerelease" : "latest"} but ` +
          `${expectedTag} is a ${expectedPrerelease ? "prerelease" : "stable release"}. This ` +
          "workflow repairs notes and assets, not classification — `gh release edit` cannot clear " +
          "a prerelease flag, and flipping it would be a publication decision. Fix it on GitHub " +
          `and re-run. See ${runbook}.`,
      );
    }

    return failures;
  }

  return { auditExistingRelease };
}
