import type { NpmRegistryState } from "../../../scripts/npm-registry-state.d.mts";

export type { NpmRegistryState } from "../../../scripts/npm-registry-state.d.mts";
export { RegistryReadTimeoutError } from "../../../scripts/npm-registry-state.d.mts";

/**
 * The shared reader bound to `NPM_CLI_VIEW_REGISTRY_ARGS` — `--registry` alone, because `fairux` is
 * unscoped and npm has no scope key to resolve first.
 *
 * `registryArgs` is deliberately absent, as on the SDK's wrapper and the CLI's registry plan: the
 * binding is what the wrapper is for, and an option that offers to replace it is an option someone
 * will take.
 */
export function getNpmRegistryState(
  spec: string,
  options?: {
    run?: (
      command: string,
      args: string[],
      options?: { timeout?: number; env?: NodeJS.ProcessEnv },
    ) => string;
    /**
     * When true, only `E404` is classified as `absent`; every other command, network, auth, or
     * timeout failure is raised rather than reported as `unavailable`.
     */
    throwOnReadError?: boolean;
  },
): NpmRegistryState;
