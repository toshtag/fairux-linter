import type { NpmRegistryState } from "../../../scripts/npm-registry-state.d.mts";

export type { NpmRegistryState } from "../../../scripts/npm-registry-state.d.mts";
export { RegistryReadTimeoutError } from "../../../scripts/npm-registry-state.d.mts";

/** The shared reader bound to `NPM_SDK_VIEW_REGISTRY_ARGS`, which pins the `@fairux` scope key. */
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
