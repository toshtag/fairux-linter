import type { NpmRegistryState } from "./npm-registry-state.d.mts";
import type { RegistryReader } from "./release-registry-wait.d.mts";

export declare const REGISTRY_PLAN_USAGE: string;

export declare class RegistryPlanUsageError extends Error {
  readonly name: "RegistryPlanUsageError";
}

export interface RegistryPlanArgs {
  spec: string;
  expectedShasum: string;
  expectedIntegrity: string;
  envFile: string | undefined;
  requirePresent: boolean;
  waitForPresent: boolean;
}

export declare function parseRegistryPlanArgs(argv: readonly string[]): RegistryPlanArgs;

export declare function createRegistryReader(options: {
  cacheRoot: string;
  /** From `scripts/public-npm-registry.mjs`; scoped packages must pin the scope key too. */
  registryArgs: readonly string[];
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

interface RegistryPlanCommon {
  spec: string;
  expectedShasum: string;
  expectedIntegrity: string;
  /** Required unless `readState` is supplied; it names the registry every read goes to. */
  registryArgs?: readonly string[];
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  delaysMs?: readonly number[];
  maxElapsedMs?: number;
  log?: (message: string) => void;
}

/**
 * Wait mode. `readState` is required and must honour the read context — build it with
 * `createRegistryReader`. There is no implicit reader: one that ignores `remainingMs` would leave
 * the subprocess unbounded and the deadline decorative.
 */
export interface WaitRegistryPlanOptions extends RegistryPlanCommon {
  waitForPresent: true;
  requirePresent: true;
  readState: RegistryReader;
}

/** Single-read mode, before or after the publish. The reader defaults to `readNpmRegistryState`. */
export interface SingleReadRegistryPlanOptions extends RegistryPlanCommon {
  waitForPresent?: false;
  requirePresent?: boolean;
  readState?: (spec: string) => NpmRegistryState | Promise<NpmRegistryState>;
}

export declare function runRegistryPlan(
  options: WaitRegistryPlanOptions | SingleReadRegistryPlanOptions,
): Promise<{ publishNeeded: boolean; status: string }>;

/**
 * The entrypoint both release paths run, given their own registry arguments.
 *
 * Owns the wait cache's lifetime: it exists only for the wait loop, only for the length of the
 * process, and each attempt reads through a directory below it.
 *
 * @returns the process exit code — 2 for a malformed invocation, 1 for a refused plan, 0 otherwise.
 */
export declare function runRegistryPlanCli(options: {
  argv: readonly string[];
  registryArgs: readonly string[];
  cachePrefix: string;
}): Promise<number>;
