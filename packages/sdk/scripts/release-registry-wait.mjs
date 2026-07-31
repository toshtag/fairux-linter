/**
 * The registry visibility wait, which knows nothing about a package.
 *
 * It moved to `scripts/release-registry-wait.mjs` when the CLI release path needed the same
 * bounded, absent-only retry. Re-exported from here so `packages/sdk/scripts/release-registry-plan.mjs`,
 * `packages/sdk/test/release-registry-wait.test.ts`, and anything else that already imported it
 * keep importing from the same place.
 */
export {
  REGISTRY_WAIT_DELAYS_MS,
  REGISTRY_WAIT_FAILURES,
  REGISTRY_WAIT_MAX_ELAPSED_MS,
  RegistryWaitError,
  waitForRegistryVersion,
} from "../../../scripts/release-registry-wait.mjs";
