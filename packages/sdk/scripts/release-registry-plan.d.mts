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
  run?: (
    cmd: string,
    args: string[],
    options?: { timeout?: number; env?: NodeJS.ProcessEnv },
  ) => string;
  readState?: (
    spec: string,
    options?: { run?: (cmd: string, args: string[]) => string },
  ) => NpmRegistryState;
}): RegistryReader;

export declare function runRegistryPlan(options: {
  spec: string;
  expectedShasum: string;
  expectedIntegrity: string;
  requirePresent?: boolean;
  waitForPresent?: boolean;
  readState?: RegistryReader;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  delaysMs?: readonly number[];
  maxElapsedMs?: number;
  log?: (message: string) => void;
}): Promise<{ publishNeeded: boolean; status: string }>;
