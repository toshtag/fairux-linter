/**
 * Which dist-tags `@fairux/sdk` may carry, before and after a publish.
 *
 * The policy is `scripts/release-channel-contract.mjs`: the placeholder rule, the `latest`/`next`
 * asymmetry, "a channel may advance and must not go backwards", and the two audits. What is here is
 * the SDK's binding — its package name and its runbook — plus the before/after comparison the SDK's
 * publish job takes a snapshot for.
 *
 * ## What this replaces
 *
 * The SDK had one audit, and it ran only *after* `npm publish`. It could establish that `next`
 * named the released version and that no other tag did, which is a current-value check, and there
 * are two things a current-value check cannot do:
 *
 * - **Refuse.** A channel found in an unexpected state after the write is found once the version is
 *   permanently spent, because npm never lets a name/version pair be reused. The CLI learned this
 *   the same way and grew a `before-publish` phase; the SDK now has it too.
 * - **Notice a channel that moved somewhere else entirely.** `latest` going from the placeholder to
 *   an unrelated release passes every check that only asks "does any tag equal this version?",
 *   because neither value is this version. That is what the before-snapshot is for, and it stays.
 *
 * The old audit also hard-coded `latest` as forbidden — a beta reaching `latest` was reported as a
 * publication decision nobody made. That is still true of a beta, and it is now expressed as
 * *precedence*: `latest` carries stable releases, so a prerelease on it is refused whatever version
 * is being published, and the one run allowed to move it is the stable release that publishes there.
 */
import {
  auditUnchangedDistTags,
  createDistTagContract,
} from "../../../scripts/release-channel-contract.mjs";
import { SDK_BOOTSTRAP_VERSION, SDK_PACKAGE_NAME, SDK_RUNBOOK } from "./sdk-release-contract.mjs";

export {
  DIST_TAG_PHASES as SDK_DIST_TAG_PHASES,
  KNOWN_DIST_TAGS as SDK_KNOWN_DIST_TAGS,
} from "../../../scripts/release-channel-contract.mjs";

const contract = createDistTagContract({
  packageName: SDK_PACKAGE_NAME,
  runbook: SDK_RUNBOOK,
  bootstrapVersion: SDK_BOOTSTRAP_VERSION,
});

/** The gate that can still refuse. Runs after the publication plan and before `npm publish`. */
export const auditSdkDistTagsBeforePublish = contract.auditBeforePublish;

/** The confirmation. Runs after the registry digest has been verified. */
export const auditSdkDistTagsAfterPublish = contract.auditAfterPublish;

/** Every tag other than this release's channel is exactly what it was before the publish. */
export { auditUnchangedDistTags };
