#!/usr/bin/env node
/**
 * Read `fairux`'s dist-tags from the public registry and hold them to the channel policy.
 *
 * Runs twice in the privileged publish job, and the two runs are not the same check.
 *
 * `--phase before-publish` runs after the publication plan and **before** `npm publish`. It is the
 * only one that can still refuse: npm never lets a name/version pair be reused, so an unexpected
 * `latest` found after the publish is found once `0.1.0-beta.1` is permanently spent. It needs the
 * plan's `--publish-needed`, because that decides what `next` is allowed to be.
 *
 * `--phase after-publish` runs after the registry digest has been verified. The digest proves the
 * right bytes are on npm; this proves they are reachable at the channel the release announced.
 *
 * Read-only in both phases. It never runs `npm dist-tag add` or `npm dist-tag rm`: a `latest` this
 * repository did not create is an owner decision, and a workflow that removed it would be
 * destroying registry state to make its own check pass.
 *
 * Node built-ins only.
 */
import { NPM_CLI_VIEW_REGISTRY_ARGS } from "../../../scripts/public-npm-registry.mjs";
import { runSync } from "../../../scripts/release-subprocess.mjs";
import {
  auditCliDistTagsAfterPublish,
  auditCliDistTagsBeforePublish,
  CLI_DIST_TAG_PHASES,
} from "./cli-dist-tag-contract.mjs";
import { CLI_PACKAGE_NAME } from "./cli-release-contract.mjs";

const USAGE =
  "Usage: verify-cli-dist-tags.mjs --phase before-publish|after-publish --version <version> " +
  "--dist-tag <tag> [--publish-needed true|false]";

function option(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function usage(message) {
  console.error(`ERROR: ${message}\n${USAGE}`);
  process.exit(2);
}

/**
 * `npm view <pkg> dist-tags --json`, not `npm dist-tag ls`.
 *
 * `npm dist-tag ls` prints `tag: version` lines with no machine-readable mode, so reading it means
 * parsing prose. `npm view … --json` returns the same map as JSON, through the same registry
 * arguments as every other read in the release path.
 */
function readDistTags(spec) {
  const stdout = runSync("npm", [
    "view",
    spec,
    "dist-tags",
    "--json",
    ...NPM_CLI_VIEW_REGISTRY_ARGS,
  ]);
  const trimmed = stdout.trim();
  if (!trimmed) throw new Error(`npm view ${spec} dist-tags returned empty output`);
  const parsed = JSON.parse(trimmed);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`npm view ${spec} dist-tags did not return an object`);
  }
  return parsed;
}

const phase = option("--phase");
const version = option("--version");
const distTag = option("--dist-tag");
const publishNeededRaw = option("--publish-needed");

if (!phase || !CLI_DIST_TAG_PHASES.includes(phase)) {
  usage(`--phase must be one of ${CLI_DIST_TAG_PHASES.join(", ")}, got ${String(phase)}`);
}
if (!version || !distTag) usage("--version and --dist-tag are required");

let publishNeeded;
if (phase === "before-publish") {
  // Only `"true"` and `"false"`. `PUBLISH_NEEDED` reaches this through `GITHUB_ENV`, and treating
  // an empty or misspelled value as falsy would silently run the rerun branch on a first publish.
  if (publishNeededRaw !== "true" && publishNeededRaw !== "false") {
    usage(`--publish-needed must be true or false, got ${String(publishNeededRaw)}`);
  }
  publishNeeded = publishNeededRaw === "true";
} else if (publishNeededRaw !== undefined) {
  usage("--publish-needed applies only to --phase before-publish");
}

let distTags;
try {
  distTags = readDistTags(CLI_PACKAGE_NAME);
} catch (error) {
  // A failed read is not a passing check. Before the publish that means refusing to publish; after
  // it, the write already happened and this run must still go red.
  const text = `${String(error.stdout ?? "")}\n${String(error.stderr ?? "")}\n${error.message}`;
  if (/\bE404\b|404 Not Found|is not in this registry/i.test(text)) {
    // The package itself is absent, which is a specific and recoverable situation rather than a
    // broken read: the bootstrap publish has not happened, so no Trusted Publisher record can
    // exist for `fairux` either and this release was never going to succeed.
    console.error(
      `ERROR: ${CLI_PACKAGE_NAME} does not exist on npm. The bootstrap publish that reserves the ` +
        "name has not been done, so no Trusted Publisher record can exist for it. See " +
        "docs/maintainers/release-cli.md.",
    );
    process.exit(1);
  }
  console.error(`ERROR: could not read ${CLI_PACKAGE_NAME} dist-tags from npm: ${error.message}`);
  process.exit(1);
}

const failures =
  phase === "before-publish"
    ? auditCliDistTagsBeforePublish({ distTags, version, distTag, publishNeeded })
    : auditCliDistTagsAfterPublish({ distTags, version, distTag });

if (failures.length > 0) {
  console.error(`\n✖ ${CLI_PACKAGE_NAME} dist-tags do not match the channel policy (${phase}):\n`);
  for (const failure of failures) console.error(`  - ${failure}`);
  if (phase === "before-publish") {
    console.error(`\nRefusing to publish ${version}. Nothing has been written to npm.`);
  }
  process.exit(1);
}

console.log(`✓ ${CLI_PACKAGE_NAME} dist-tags match the channel policy (${phase})`);
for (const [tag, tagged] of Object.entries(distTags).sort()) {
  console.log(`  ${tag}: ${tagged}`);
}
