/** Corpus case ids the behaviour digest reads. Frozen: a case joins by being added here. */
export const BEHAVIOUR_PROBE_CASES: readonly string[];

/** Findings per rule per probe. `scanPage` returns one page's findings, by case id. */
export function measureBehaviour(
  scanPage: (caseId: string) => readonly { readonly ruleId: string }[],
): Record<string, Record<string, number>>;

export function summariseBehaviour(behaviour: Record<string, Record<string, number>>): {
  readonly probes: number;
  readonly rulesObserved: readonly string[];
  readonly findings: number;
  readonly sha256: string;
};
