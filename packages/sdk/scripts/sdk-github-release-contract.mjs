/**
 * What an existing `@fairux/sdk` GitHub Release must already be, before this workflow edits it.
 *
 * The reasoning is in `scripts/github-release-contract.mjs`. What this file adds is the SDK's
 * runbook — and the reason the SDK needs the contract at all, which is new: `publish-sdk.yml`
 * created and edited every Release with a bare `--prerelease`, because every SDK release was a
 * beta. That is a hard-coded classification, so a stable release would have been announced as a
 * prerelease, and a rerun over a correctly-classified Release would have tried to push it back.
 */
import {
  createGithubReleaseContract,
  RELEASE_VIEW_FIELDS,
} from "../../../scripts/github-release-contract.mjs";
import { SDK_RUNBOOK } from "./sdk-release-contract.mjs";

/** The fields `gh release view --json` must return for this contract to have an opinion. */
export const SDK_RELEASE_VIEW_FIELDS = RELEASE_VIEW_FIELDS;

const contract = createGithubReleaseContract({ runbook: SDK_RUNBOOK });

/** Whether an existing Release may be repaired in place, or names the owner instead. */
export const auditExistingSdkRelease = contract.auditExistingRelease;
