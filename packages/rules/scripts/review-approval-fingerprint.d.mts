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

/** The SHA-256 the review baseline pins as `reviewContentSha256`. */
export function computeReviewApprovalFingerprint(input: ReviewApprovalFingerprintInput): string;
