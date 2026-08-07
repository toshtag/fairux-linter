#!/usr/bin/env node
/**
 * Resolve a dist-tag reading to the exact published version a registry canary should install.
 *
 * Reads the JSON `npm-registry-state.mjs` wrote, applies `registry-channel-contract.mjs`, and
 * writes `<VAR>=<version>` to `GITHUB_ENV`. It replaces four shell lines that were duplicated in
 * both canary workflows — a `node -p` status read, a `node -p` version read, a `check-semver.mjs`
 * call, and the `>> "$GITHUB_ENV"` write — none of which could say anything about the placeholder
 * `latest` holds before a package's first stable release.
 *
 * Node built-ins only.
 */
import { appendFileSync, readFileSync } from "node:fs";
import { resolveRegistryChannel } from "./registry-channel-contract.mjs";

const USAGE =
  "Usage: resolve-registry-channel.mjs --state <path> --spec <spec> --var <NAME> " +
  "[--github-env <path>]";

function option(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const statePath = option("--state");
const spec = option("--spec");
const variable = option("--var");
const githubEnv = option("--github-env") ?? process.env.GITHUB_ENV;

if (!statePath || !spec || !variable) {
  console.error(USAGE);
  process.exit(2);
}
// The variable name is written into `GITHUB_ENV` verbatim, so it is held to the shape an
// environment variable may have rather than trusted because it came from the workflow.
if (!/^[A-Z][A-Z0-9_]*$/.test(variable)) {
  console.error(`ERROR: --var must be an upper-case identifier, got ${JSON.stringify(variable)}`);
  process.exit(2);
}

let state;
try {
  state = JSON.parse(readFileSync(statePath, "utf8"));
} catch (error) {
  console.error(`ERROR: could not read the registry state at ${statePath}: ${error.message}`);
  process.exit(1);
}

const resolved = resolveRegistryChannel({ state, spec });
if ("failures" in resolved) {
  console.error(`\n✖ ${spec} cannot be smoked:\n`);
  for (const failure of resolved.failures) console.error(`  - ${failure}`);
  process.exit(1);
}

console.log(`✓ ${spec} resolves to ${resolved.version}`);
if (githubEnv) appendFileSync(githubEnv, `${variable}=${resolved.version}\n`, "utf8");
