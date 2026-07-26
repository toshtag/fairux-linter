export function renderRuleCatalogArtifacts(input: unknown): {
  readonly summary: unknown;
  readonly catalogData: unknown;
  readonly artifacts: readonly {
    readonly path: string;
    readonly contents: string;
  }[];
};

export function runtimeGovernanceProjectionFromPack(input: unknown): Record<string, unknown>;

export function validateRuntimeGovernanceParity(
  expectedProjection: unknown,
  input: unknown,
): {
  readonly ok: boolean;
  readonly errors: readonly string[];
  readonly actualProjection: Record<string, unknown>;
};
