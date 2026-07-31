#!/usr/bin/env node
/**
 * `@fairux/sdk`'s registry read: the shared reader, bound to the SDK's registry arguments.
 *
 * The classification — `absent`, `present`, `unavailable`, and the timeout distinction — moved to
 * `scripts/npm-registry-state.mjs` when the CLI release path needed the same read. What stays here
 * is the one SDK-specific value: npm resolves a scoped package through `@fairux:registry` before it
 * falls back to `registry`, so an `.npmrc` line would otherwise point this read somewhere other
 * than where `npm publish` writes. `NPM_SDK_VIEW_REGISTRY_ARGS` pins both keys.
 */
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readNpmRegistryState } from "../../../scripts/npm-registry-state.mjs";
import { NPM_SDK_VIEW_REGISTRY_ARGS } from "../../../scripts/public-npm-registry.mjs";

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
    registryArgs: NPM_SDK_VIEW_REGISTRY_ARGS,
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const specIndex = process.argv.indexOf("--spec");
  const spec = specIndex >= 0 ? process.argv[specIndex + 1] : process.argv[2];
  if (!spec) {
    console.error("Usage: npm-registry-state.mjs --spec @fairux/sdk@<version>");
    process.exit(2);
  }
  const state = getNpmRegistryState(spec);
  console.log(JSON.stringify(state, null, 2));
  process.exitCode = state.status === "unavailable" ? 1 : 0;
}
