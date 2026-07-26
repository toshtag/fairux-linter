import type { RuntimeRuleMetadata } from "./review-validation.d.mts";

export function validateApprovalEvidence(input: {
  readonly approvalEvidence: unknown;
  readonly sourceCatalog: unknown;
  readonly reviewRecords: unknown;
  readonly runtimeRules: readonly RuntimeRuleMetadata[];
  readonly repository?: string;
  readonly pullNumber?: number;
}): {
  readonly ok: boolean;
  readonly errors: string[];
  readonly summary: Record<string, unknown>;
};
