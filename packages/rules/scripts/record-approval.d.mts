export type ApprovalFacts = {
  readonly reviewContentSha256: string;
  readonly detectionDigest: string;
  readonly approvedStableRuleIds: readonly string[];
  readonly reviewedExperimentalRuleIds: readonly string[];
  readonly approvedRules: readonly { readonly ruleId: string; readonly ruleVersion: string }[];
  readonly acknowledgedUncoveredScenarioCount: number;
  readonly openReviewExceptionCount: number;
  /** Stable records still `prepared`. A run that finds none is a run nobody needed. */
  readonly preparedRuleIds: readonly string[];
};

export type ApprovalIdentity = {
  readonly approvalTargetCommit: string;
  readonly approvedBy: string;
  readonly approvedAt: string;
  readonly workflowRunUrl: string;
};

/** Measure the built packages and the review records as they stand. */
export function measureApprovalFacts(): Promise<ApprovalFacts>;

/** The packet as it would be written. Pure. */
export function buildApprovalPacket(
  facts: ApprovalFacts,
  approval: ApprovalIdentity,
): Record<string, unknown>;

/** Move every prepared stable record to `maintainer-approved`. Pure. */
export function approveRecords(
  reviewRecords: Record<string, unknown>,
  approval: ApprovalIdentity,
): Record<string, unknown>;
