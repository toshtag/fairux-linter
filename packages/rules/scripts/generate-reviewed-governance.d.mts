export function renderReviewedGovernanceArtifacts(input: unknown): {
  readonly summary: unknown;
  readonly artifacts: readonly {
    readonly path: string;
    readonly contents: string;
  }[];
};

export function reviewedGovernance(
  records: unknown,
  sourcesById: ReadonlyMap<string, unknown>,
): Record<string, unknown>;
