#!/usr/bin/env node
/**
 * Read `fairux`'s dist-tags from the public registry and hold them to the channel policy.
 *
 * Runs in the privileged publish job, after the registry digest has been verified: the digest
 * proves the right bytes are on npm, and this proves they are reachable at the channel the release
 * announced — and that `latest` is not quietly pointing somewhere a plain `npm install fairux`
 * would find. Two separate claims, so they fail separately.
 *
 * Read-only. It never runs `npm dist-tag add` or `npm dist-tag rm`: a `latest` this repository did
 * not create is an owner decision, and a workflow that removed it would be destroying registry
 * state to make its own check pass.
 *
 * Node built-ins only.
 */
import { NPM_CLI_VIEW_REGISTRY_ARGS } from "../../../scripts/public-npm-registry.mjs";
import { runSync } from "../../../scripts/release-subprocess.mjs";
import { auditCliDistTags } from "./cli-dist-tag-contract.mjs";
import { CLI_PACKAGE_NAME } from "./cli-release-contract.mjs";

const USAGE = "Usage: verify-cli-dist-tags.mjs --version <version> --dist-tag <tag>";

function option(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
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

const version = option("--version");
const distTag = option("--dist-tag");
if (!version || !distTag) {
  console.error(USAGE);
  process.exit(2);
}

let distTags;
try {
  distTags = readDistTags(CLI_PACKAGE_NAME);
} catch (error) {
  // A failed read is not a passing check. The publish already happened; this run must still go red.
  console.error(`ERROR: could not read ${CLI_PACKAGE_NAME} dist-tags from npm: ${error.message}`);
  process.exit(1);
}

const failures = auditCliDistTags({ distTags, version, distTag });
if (failures.length > 0) {
  console.error(`\n✖ ${CLI_PACKAGE_NAME} dist-tags do not match the channel policy:\n`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

console.log(`✓ ${CLI_PACKAGE_NAME} dist-tags match the channel policy`);
for (const [tag, tagged] of Object.entries(distTags).sort()) {
  console.log(`  ${tag}: ${tagged}`);
}
