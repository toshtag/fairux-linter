import type { RuntimeRuleMetadata } from "./review-validation.d.mts";

export function validateApprovalEvidence(input: {
  readonly approvalEvidence: unknown;
  readonly sourceCatalog: unknown;
  readonly reviewRecords: unknown;
  readonly runtimeRules: readonly RuntimeRuleMetadata[];
  /**
   * SHA-256 of what the built rules match with. Absent is a refusal, not a pass: a caller that
   * cannot compute it cannot confirm the approval covers what the rules do.
   */
  readonly detectionDigest?: string;
  readonly repository?: string;
  readonly pullNumber?: number;
  /** Defaults to the P13 maintainer, `toshtag`. */
  readonly expectedApprover?: string;
  /** Defaults to the P13 Stage A approval target, `69f6d538...`. */
  readonly expectedApprovalTargetCommit?: string;
}): {
  readonly ok: boolean;
  readonly errors: string[];
  readonly summary: Record<string, unknown>;
};
