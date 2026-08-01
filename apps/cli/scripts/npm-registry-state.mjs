#!/usr/bin/env node
/**
 * `fairux`'s registry read: the shared reader, bound to the CLI's registry arguments.
 *
 * The SDK has the same wrapper for the same reason, and the difference between the two is the whole
 * point of the shared module taking the arguments rather than defaulting them. `@fairux/sdk` is
 * scoped, so npm resolves it through `@fairux:registry` before falling back to `registry` and both
 * keys have to be pinned. `fairux` is unscoped and has no scope key, so `--registry` is the whole
 * answer — adding a scope pin here would suggest a resolution path this package does not have.
 *
 * `release-registry-plan.mjs` already binds the same arguments for the publish path. This file
 * exists because the registry-installed smoke needs the plain read on its own, without a
 * publication plan around it: it is asking what the `next` dist-tag currently names, not what a
 * release should do about it.
 */
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readNpmRegistryState } from "../../../scripts/npm-registry-state.mjs";
import { NPM_CLI_VIEW_REGISTRY_ARGS } from "../../../scripts/public-npm-registry.mjs";

export { RegistryReadTimeoutError } from "../../../scripts/npm-registry-state.mjs";

/**
 * @param {string} spec
 * @param {object} [options]
 * @param {(cmd: string, args: string[], options?: object) => string} [options.run]
 * @param {boolean} [options.throwOnReadError]
 */
export function getNpmRegistryState(spec, options = {}) {
  return readNpmRegistryState(spec, {
    ...options,
    registryArgs: NPM_CLI_VIEW_REGISTRY_ARGS,
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const specIndex = process.argv.indexOf("--spec");
  const spec = specIndex >= 0 ? process.argv[specIndex + 1] : process.argv[2];
  if (!spec) {
    console.error("Usage: npm-registry-state.mjs --spec fairux@<version-or-dist-tag>");
    process.exit(2);
  }
  const state = getNpmRegistryState(spec);
  console.log(JSON.stringify(state, null, 2));
  process.exitCode = state.status === "unavailable" ? 1 : 0;
}
