#!/usr/bin/env node
/**
 * `fairux`'s registry publication plan: the shared plan, bound to the CLI's registry arguments.
 *
 * `publish-cli.yml` called `npm publish` unconditionally and stopped there. Three consequences the
 * M1-R1 audit recorded, all fixed by running this before and after the publish:
 *
 * - A rerun of a *successful* release attempted to republish and went red on `E409`. The version
 *   was on npm and the run said the release had failed.
 * - A version already present with **different bytes** was left to the registry to reject. There
 *   was no hard, explanatory failure naming the digest mismatch — the one case that must never be
 *   retried or skipped.
 * - Nothing compared what npm stored to what the workflow audited. The CLI could say "these exact
 *   bytes were handed to npm", which is strictly weaker than "these exact bytes are on the
 *   registry", and `--provenance` was attached but never read back.
 *
 * `fairux` is unscoped, so the registry arguments are just `--registry`: there is no
 * `@fairux:registry` key for npm to resolve first. That is the only difference from the SDK's
 * wrapper, and it is why the shared module takes the arguments rather than defaulting them.
 */
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { NPM_CLI_VIEW_REGISTRY_ARGS } from "../../../scripts/public-npm-registry.mjs";
import {
  createRegistryReader as createSharedRegistryReader,
  runRegistryPlanCli,
} from "../../../scripts/release-registry-plan.mjs";

export {
  parseRegistryPlanArgs,
  REGISTRY_PLAN_USAGE,
  RegistryPlanUsageError,
  runRegistryPlan,
} from "../../../scripts/release-registry-plan.mjs";

/**
 * The shared reader, bound to the registry arguments every `fairux` read must carry.
 *
 * `registryArgs` is spread **last**. Written the other way round — the fixed value first, then
 * `...options` — a caller passing `registryArgs: ["--registry=https://untrusted.invalid/"]` silently
 * replaced it, and every read in the release path went to that host. "Bound to the package's
 * registry" has to be a property the wrapper enforces, not a default it offers, because the whole
 * reason this wrapper exists is that the shared core cannot know which registry a package resolves
 * through. The `.d.mts` beside this file does not declare the option at all.
 */
export function createRegistryReader(options) {
  return createSharedRegistryReader({ ...options, registryArgs: NPM_CLI_VIEW_REGISTRY_ARGS });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await runRegistryPlanCli({
    argv: process.argv.slice(2),
    registryArgs: NPM_CLI_VIEW_REGISTRY_ARGS,
    // Distinct from the SDK's, so two release runs on one machine cannot share a wait cache.
    cachePrefix: "fairux-cli-registry-wait-cache-",
  });
}
