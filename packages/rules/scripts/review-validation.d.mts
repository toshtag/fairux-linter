export type RuntimeRuleMetadata = {
  readonly id: string;
  readonly version: string;
  readonly maturity: string;
  readonly experimental: boolean;
  readonly defaultEnabled: boolean;
};

export type ValidationResult = {
  readonly errors: string[];
};

export function compareCanonicalId(left: string, right: string): number;
export function collectRuntimeRuleMetadata(rules: readonly unknown[]): RuntimeRuleMetadata[];
export function validateSourceCatalog(catalog: unknown): ValidationResult & {
  readonly sources: Map<string, unknown>;
};
export function validateReviewRecords(
  records: unknown,
  sources: Map<string, unknown>,
  options?: { readonly requireApprovedStable?: boolean },
): ValidationResult & { readonly counts: Record<string, number> };
export function validateRuleMetadataParity(
  records: unknown,
  runtimeRules: readonly RuntimeRuleMetadata[],
): ValidationResult;
export function validateCorpusReferences(
  records: unknown,
  options?: {
    readonly rootDir?: string;
    readonly readFile?: (path: string) => string;
  },
): ValidationResult;
export function validateReviewFoundation(input: {
  readonly sourceCatalog: unknown;
  readonly reviewRecords: unknown;
  readonly runtimeRules: readonly RuntimeRuleMetadata[];
  readonly rootDir?: string;
  readonly requireApprovedStable?: boolean;
}): {
  readonly ok: boolean;
  readonly errors: string[];
  readonly summary: Record<string, unknown>;
};
