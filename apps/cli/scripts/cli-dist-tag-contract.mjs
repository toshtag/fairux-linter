/**
 * Which dist-tags `fairux` may carry, before and after a publish.
 *
 * The policy — the placeholder rule, the `latest`/`next` asymmetry, "a channel may advance and must
 * not go backwards", and the two audits — is in `scripts/release-channel-contract.mjs`. It moved
 * there when the SDK's release path stopped being beta-only and needed the same guarantees:
 * duplicating it would have produced two channel policies that agree until one of them is fixed.
 *
 * What stays here is what is actually specific to `fairux` — its name, and the runbook a refusal
 * sends a reader to — plus the exported names the CLI release scripts and their tests already use.
 */
import {
  BOOTSTRAP_VERSION,
  createDistTagContract,
  DIST_TAG_PHASES,
  KNOWN_DIST_TAGS,
} from "../../../scripts/release-channel-contract.mjs";
import { CLI_PACKAGE_NAME } from "./cli-release-contract.mjs";

/** Tags this repository knows about. Anything else is reported rather than ignored. */
export const CLI_KNOWN_DIST_TAGS = KNOWN_DIST_TAGS;

/** The two sides of `npm publish` this module audits. */
export const CLI_DIST_TAG_PHASES = DIST_TAG_PHASES;

const contract = createDistTagContract({
  packageName: CLI_PACKAGE_NAME,
  runbook: "docs/maintainers/release-cli.md",
  bootstrapVersion: BOOTSTRAP_VERSION,
});

/** The gate that can still refuse. Runs after the publication plan and before `npm publish`. */
export const auditCliDistTagsBeforePublish = contract.auditBeforePublish;

/** The confirmation. Runs after the registry digest has been verified. */
export const auditCliDistTagsAfterPublish = contract.auditAfterPublish;
