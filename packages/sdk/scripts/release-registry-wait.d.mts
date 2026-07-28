import type { NpmRegistryState } from "./npm-registry-state.d.mts";

export declare const REGISTRY_WAIT_DELAYS_MS: readonly number[];
export declare const REGISTRY_WAIT_MAX_ELAPSED_MS: 120_000;

export declare const REGISTRY_WAIT_FAILURES: {
  readonly SHASUM_MISMATCH: "shasum_mismatch";
  readonly INTEGRITY_MISMATCH: "integrity_mismatch";
  readonly UNAVAILABLE: "unavailable";
  readonly READ_FAILED: "read_failed";
  readonly TIMED_OUT: "timed_out";
};

export type RegistryWaitFailureReason =
  (typeof REGISTRY_WAIT_FAILURES)[keyof typeof REGISTRY_WAIT_FAILURES];

export declare class RegistryWaitError extends Error {
  readonly name: "RegistryWaitError";
  readonly reason: RegistryWaitFailureReason;
  readonly spec: string;
  readonly attempts: number;
  readonly elapsedMs: number;
  constructor(
    message: string,
    details: {
      reason: RegistryWaitFailureReason;
      spec: string;
      attempts: number;
      elapsedMs: number;
    },
  );
}

/** What a read is told about the deadline it has to finish inside. */
export interface RegistryReadContext {
  attempt: number;
  remainingMs: number;
}

export interface RegistryWaitAttempt {
  attempt: number;
  status: NpmRegistryState["status"];
  elapsedMs: number;
  remainingMs: number;
  /** Present only when the attempt was `absent` and another read is both scheduled and affordable. */
  nextDelayMs: number | undefined;
}

export type RegistryReader = (
  spec: string,
  context: RegistryReadContext,
) => NpmRegistryState | Promise<NpmRegistryState>;

export declare function waitForRegistryVersion(options: {
  spec: string;
  expectedShasum: string;
  expectedIntegrity: string;
  readState: RegistryReader;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  delaysMs?: readonly number[];
  maxElapsedMs?: number;
  onAttempt?: (attempt: RegistryWaitAttempt) => void;
}): Promise<{
  version: string;
  shasum: string;
  integrity: string;
  attempts: number;
  elapsedMs: number;
}>;
