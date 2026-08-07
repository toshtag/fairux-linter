/**
 * What an existing `fairux` GitHub Release must already be, before this workflow edits it.
 *
 * The reasoning — why repair covers notes, title, and assets but never classification — is in
 * `scripts/github-release-contract.mjs`. It moved there when the SDK's workflow stopped classifying
 * every Release as a prerelease and needed the same refusal.
 *
 * What stays here is the runbook a refusal points at, and the exported names the CLI release
 * scripts and their tests already use.
 */
import {
  createGithubReleaseContract,
  RELEASE_VIEW_FIELDS,
} from "../../../scripts/github-release-contract.mjs";

/** The fields `gh release view --json` must return for this contract to have an opinion. */
export const CLI_RELEASE_VIEW_FIELDS = RELEASE_VIEW_FIELDS;

const contract = createGithubReleaseContract({ runbook: "docs/maintainers/release-cli.md" });

/** Whether an existing Release may be repaired in place, or names the owner instead. */
export const auditExistingCliRelease = contract.auditExistingRelease;
