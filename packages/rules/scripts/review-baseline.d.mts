type RuleEntry = { readonly ruleId: string; readonly ruleVersion: string };

export type ReviewBaseline = {
  readonly schemaVersion: number;
  readonly reviewContentSha256: string;
  readonly detectionDigest: string;
  readonly rules: readonly RuleEntry[];
};

export const BASELINE_SCHEMA_VERSION: number;

export function buildReviewBaseline(input: {
  readonly reviewContentSha256: string;
  readonly detectionDigest: string;
  readonly reviewRecords: unknown;
}): ReviewBaseline;

export function validateReviewBaseline(input: {
  readonly baseline: unknown;
  readonly current: { readonly reviewContentSha256: string; readonly detectionDigest: string };
  readonly runtimeRules: readonly {
    readonly id: string;
    readonly version: string;
    readonly maturity: string;
  }[];
}): { readonly ok: boolean; readonly errors: string[]; readonly summary: Record<string, unknown> };

export function serializeReviewBaseline(baseline: ReviewBaseline): string;
export function summariseReviewBaseline(baseline: ReviewBaseline): string;
