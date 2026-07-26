export type ReviewApprovalFingerprintInput = {
  readonly sourceCatalog: {
    readonly schemaVersion?: number;
    readonly sources?: readonly Record<string, unknown>[];
  };
  readonly reviewRecords: {
    readonly schemaVersion?: number;
    readonly reviewPolicy?: Record<string, unknown>;
    readonly rules?: readonly Record<string, unknown>[];
  };
};

export type ReviewApprovalFingerprintResult = {
  readonly schemaVersion: 1;
  readonly ruleCount: number;
  readonly stableRuleCount: number;
  readonly experimentalRuleCount: number;
  readonly uncoveredScenarioCount: number;
  readonly openExceptionCount: number;
  readonly reviewContentSha256: string;
};

export function computeReviewApprovalFingerprint(
  input: ReviewApprovalFingerprintInput,
): ReviewApprovalFingerprintResult;

export function buildReviewApprovalFingerprintPayload(
  input: ReviewApprovalFingerprintInput,
): Record<string, unknown>;
