import type { NpmRegistryState } from "./npm-registry-state.d.mts";

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

export declare function runRegistryPlan(options: {
  spec: string;
  expectedShasum: string;
  expectedIntegrity: string;
  requirePresent?: boolean;
  waitForPresent?: boolean;
  readState?: (spec: string) => NpmRegistryState | Promise<NpmRegistryState>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  delaysMs?: readonly number[];
  log?: (message: string) => void;
}): Promise<{ publishNeeded: boolean; status: string }>;
