import type { NpmRegistryState } from "../../../scripts/npm-registry-state.d.mts";
import type { RegistryReader } from "../../../scripts/release-registry-wait.d.mts";

export type {
  RegistryPlanArgs,
  SingleReadRegistryPlanOptions,
  WaitRegistryPlanOptions,
} from "../../../scripts/release-registry-plan.d.mts";

export {
  parseRegistryPlanArgs,
  REGISTRY_PLAN_USAGE,
  RegistryPlanUsageError,
  runRegistryPlan,
} from "../../../scripts/release-registry-plan.d.mts";

/**
 * The shared reader, bound to `NPM_CLI_VIEW_REGISTRY_ARGS`.
 *
 * `registryArgs` is deliberately absent from this type. The binding is the wrapper's whole
 * purpose, and declaring it optional invited a caller to replace it — which the implementation
 * then honoured, because the fixed value was spread first.
 */
export declare function createRegistryReader(options: {
  cacheRoot: string;
  run?: (
    cmd: string,
    args: string[],
    options?: { timeout?: number; env?: NodeJS.ProcessEnv },
  ) => string;
  readState?: (
    spec: string,
    options?: {
      registryArgs?: readonly string[];
      run?: (cmd: string, args: string[]) => string;
      throwOnReadError?: boolean;
    },
  ) => NpmRegistryState;
}): RegistryReader;
