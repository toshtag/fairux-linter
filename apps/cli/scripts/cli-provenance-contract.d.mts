export declare const CLI_PROVENANCE_PREDICATE_PREFIX: "https://slsa.dev/provenance/";
export declare const CLI_PROVENANCE_STATES: readonly ["present", "absent", "invalid"];

export type CliProvenanceState = (typeof CLI_PROVENANCE_STATES)[number];

/**
 * Classify `dist.attestations` for one published version.
 *
 * `absent` is the only state a caller may retry: metadata that has not propagated yet becomes
 * visible, and metadata of the wrong shape does not become the right shape by being read again.
 */
export declare function classifyCliProvenance(input: { attestations: unknown }): {
  state: CliProvenanceState;
  failures: string[];
};

/**
 * Read until the metadata is present, or the shared registry deadline is reached.
 *
 * Only `absent` is retried. The clock, the sleeper, and the reader are injected, so the deadline
 * is asserted exactly and the tests take no real time.
 */
export declare function waitForCliProvenance(options: {
  spec: string;
  read: (spec: string) => unknown | Promise<unknown>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  delaysMs?: readonly number[];
  maxElapsedMs?: number;
  log?: (message: string) => void;
}): Promise<{ state: CliProvenanceState; failures: string[]; attempts: number }>;
