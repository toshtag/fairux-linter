#!/usr/bin/env node
/**
 * `@fairux/sdk`'s registry publication plan: the shared plan, bound to the SDK's registry arguments.
 *
 * The three states, the conflict rule, and the "only absence is retried" rule moved to
 * `scripts/release-registry-plan.mjs` when the CLI release path needed the same guarantees. What
 * stays here is the SDK's registry arguments — a scoped package resolves through `@fairux:registry`
 * first — and the temp-directory prefix, so a CLI run and an SDK run on the same machine cannot
 * share a wait cache.
 */
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { NPM_SDK_VIEW_REGISTRY_ARGS } from "../../../scripts/public-npm-registry.mjs";
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
 * The shared reader, bound to the registry arguments every `@fairux/*` read must carry.
 *
 * `registryArgs` is spread **last**, for the reason spelled out in the CLI's wrapper: with the
 * fixed value first and `...options` after it, a caller could replace the registry this reader
 * reads. Before the shared core existed this file hardcoded the arguments and there was no option
 * to override, so the extraction had to keep that property rather than turn it into a default.
 */
export function createRegistryReader(options) {
  return createSharedRegistryReader({ ...options, registryArgs: NPM_SDK_VIEW_REGISTRY_ARGS });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await runRegistryPlanCli({
    argv: process.argv.slice(2),
    registryArgs: NPM_SDK_VIEW_REGISTRY_ARGS,
    cachePrefix: "fairux-sdk-registry-wait-cache-",
  });
}
