export function renderRuleCatalogArtifacts(input: unknown): {
  readonly summary: unknown;
  readonly catalogData: unknown;
  readonly artifacts: readonly {
    readonly path: string;
    readonly contents: string;
  }[];
};
