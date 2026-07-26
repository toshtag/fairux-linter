import { describe, expect, it } from "vitest";
import reviewRecordsFixture from "../reviews/built-in-rule-reviews.json" with { type: "json" };
import sourceCatalogFixture from "../reviews/official-sources.json" with { type: "json" };
import { computeReviewApprovalFingerprint } from "../scripts/review-approval-fingerprint.mjs";
import { validateApprovalEvidence } from "../scripts/review-approval-validation.mjs";
import { collectRuntimeRuleMetadata } from "../scripts/review-validation.mjs";
import { fairuxBuiltinRulePack } from "../src/index.js";

type MutableFixture = Record<string, unknown>;
type RuntimeRuleFixture = {
  id: string;
  version: string;
  maturity: string;
  experimental: boolean;
  defaultEnabled: boolean;
};

const APPROVED_BY = "maintainer-fixture";
const APPROVED_AT = "2026-07-26";
const APPROVAL_TARGET_COMMIT = "0123456789abcdef0123456789abcdef01234567";
const APPROVAL_COMMENT_URL = "https://github.com/toshtag/fairux-linter/pull/56#issuecomment-1";
const PRODUCTION_APPROVER = "toshtag";
const PRODUCTION_TARGET_COMMIT = "69f6d53873863f70c03ce8837be88224017487d7";
const STABLE_RULE_ID = "consent/bundled-consent";
const EXPERIMENTAL_RULE_ID = "consent/accept-reject-visual-imbalance";

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function runtimeRules(): RuntimeRuleFixture[] {
  return collectRuntimeRuleMetadata(fairuxBuiltinRulePack.rules) as RuntimeRuleFixture[];
}

function ruleIdsByMaturity(records: MutableFixture, maturity: string): string[] {
  return (records.rules as MutableFixture[])
    .filter((rule) => rule.maturity === maturity)
    .map((rule) => rule.ruleId as string);
}

function ruleOf(records: MutableFixture, ruleId: string): MutableFixture {
  const rule = (records.rules as MutableFixture[]).find((entry) => entry.ruleId === ruleId);
  if (rule === undefined) throw new Error(`missing ${ruleId} fixture`);
  return rule;
}

/** The packet as Stage B writes it: stable approved, experimental untouched. */
function approvedRecords(
  mutate?: (records: MutableFixture) => void,
  approver: string = APPROVED_BY,
): MutableFixture {
  const records = clone(reviewRecordsFixture) as unknown as MutableFixture;
  for (const rule of records.rules as MutableFixture[]) {
    if (rule.maturity !== "stable") continue;
    rule.status = "maintainer-approved";
    rule.approvedBy = approver;
    rule.approvedAt = APPROVED_AT;
  }
  mutate?.(records);
  return records;
}

function fingerprintOf(records: MutableFixture) {
  return computeReviewApprovalFingerprint({
    sourceCatalog: clone(sourceCatalogFixture),
    reviewRecords: records,
  });
}

function evidenceFor(records: MutableFixture, overrides: MutableFixture = {}): MutableFixture {
  const fingerprint = fingerprintOf(records);
  return {
    schemaVersion: 1,
    phase: "P13",
    task: "P13-T7",
    approvalTargetCommit: APPROVAL_TARGET_COMMIT,
    reviewContentSha256: fingerprint.reviewContentSha256,
    approvalCommentUrl: APPROVAL_COMMENT_URL,
    approvedBy: APPROVED_BY,
    approvedAt: APPROVED_AT,
    approvedStableRuleIds: ruleIdsByMaturity(records, "stable"),
    reviewedExperimentalRuleIds: ruleIdsByMaturity(records, "experimental"),
    experimentalDisposition: "reviewed-retained-prepared-default-off",
    acknowledgedUncoveredScenarioCount: fingerprint.uncoveredScenarioCount,
    openReviewExceptionCount: fingerprint.openExceptionCount,
    ...overrides,
  };
}

/**
 * Fixture cases override the approver and approval target so they exercise the
 * evidence contract rather than the P13 policy defaults. The defaults
 * themselves are pinned separately, below.
 */
const FIXTURE_POLICY = {
  expectedApprover: APPROVED_BY,
  expectedApprovalTargetCommit: APPROVAL_TARGET_COMMIT,
};

function validate(options: {
  records?: MutableFixture;
  evidence?: MutableFixture;
  runtimeRules?: RuntimeRuleFixture[];
  policy?: { expectedApprover?: string; expectedApprovalTargetCommit?: string };
}) {
  const records = options.records ?? approvedRecords();
  return validateApprovalEvidence({
    approvalEvidence: options.evidence ?? evidenceFor(records),
    sourceCatalog: clone(sourceCatalogFixture),
    reviewRecords: records,
    runtimeRules: options.runtimeRules ?? runtimeRules(),
    ...(options.policy ?? FIXTURE_POLICY),
  });
}

function rejects(options: Parameters<typeof validate>[0], expected: string | RegExp) {
  const result = validate(options);
  expect(result.ok).toBe(false);
  expect(result.errors.join("\n")).toMatch(expected);
}

describe("maintainer approval evidence", () => {
  it("accepts evidence that matches the approved review packet", () => {
    const result = validate({});

    expect(result.errors).toEqual([]);
    expect(result.summary).toMatchObject({
      ok: true,
      phase: "P13",
      task: "P13-T7",
      approvedBy: APPROVED_BY,
      approvedAt: APPROVED_AT,
      approvedStableRuleCount: 11,
      reviewedExperimentalRuleCount: 2,
      acknowledgedUncoveredScenarioCount: 13,
      openReviewExceptionCount: 0,
    });
  });

  it("rejects evidence with an unknown field", () => {
    const records = approvedRecords();
    rejects(
      { records, evidence: evidenceFor(records, { approvalNote: "looks fine" }) },
      "contains unknown field approvalNote",
    );
  });

  it("rejects evidence with a missing field", () => {
    const records = approvedRecords();
    const evidence = evidenceFor(records);
    delete evidence.approvalCommentUrl;

    rejects({ records, evidence }, "missing required field approvalCommentUrl");
  });

  it("rejects a mismatched phase, task, or schema version", () => {
    const records = approvedRecords();

    rejects({ records, evidence: evidenceFor(records, { schemaVersion: 2 }) }, "schemaVersion");
    rejects({ records, evidence: evidenceFor(records, { phase: "P14" }) }, "phase must be P13");
    rejects({ records, evidence: evidenceFor(records, { task: "P13-T1" }) }, "task must be P13-T7");
  });

  it("rejects a malformed approval target commit", () => {
    const records = approvedRecords();

    rejects(
      { records, evidence: evidenceFor(records, { approvalTargetCommit: "69f6d53" }) },
      "40-character lowercase commit SHA",
    );
    rejects(
      {
        records,
        evidence: evidenceFor(records, {
          approvalTargetCommit: APPROVAL_TARGET_COMMIT.toUpperCase(),
        }),
      },
      "40-character lowercase commit SHA",
    );
  });

  it("rejects a fingerprint that does not match the current review content", () => {
    const records = approvedRecords();

    rejects(
      { records, evidence: evidenceFor(records, { reviewContentSha256: "0".repeat(64) }) },
      "must equal the current substantive fingerprint",
    );
  });

  it("rejects an approval comment URL that is not https", () => {
    const records = approvedRecords();

    rejects(
      {
        records,
        evidence: evidenceFor(records, {
          approvalCommentUrl: "http://github.com/toshtag/fairux-linter/pull/56#issuecomment-1",
        }),
      },
      "must use https",
    );
  });

  it("rejects an approval comment URL for another repository or pull request", () => {
    const records = approvedRecords();

    rejects(
      {
        records,
        evidence: evidenceFor(records, {
          approvalCommentUrl: "https://github.com/attacker/fairux-linter/pull/56#issuecomment-1",
        }),
      },
      "must point at toshtag/fairux-linter pull request 56",
    );
    rejects(
      {
        records,
        evidence: evidenceFor(records, {
          approvalCommentUrl: "https://github.com/toshtag/fairux-linter/pull/57#issuecomment-1",
        }),
      },
      "must point at toshtag/fairux-linter pull request 56",
    );
  });

  it("rejects an approval comment URL without a comment anchor", () => {
    const records = approvedRecords();

    rejects(
      {
        records,
        evidence: evidenceFor(records, {
          approvalCommentUrl: "https://github.com/toshtag/fairux-linter/pull/56",
        }),
      },
      "#issuecomment-<digits>",
    );
  });

  it("accepts the canonical issues path GitHub also serves comments under", () => {
    const records = approvedRecords();
    const result = validate({
      records,
      evidence: evidenceFor(records, {
        approvalCommentUrl: "https://github.com/toshtag/fairux-linter/issues/56#issuecomment-1",
      }),
    });

    expect(result.errors).toEqual([]);
  });

  it("rejects an empty approver or an invalid approval date", () => {
    const records = approvedRecords();

    rejects({ records, evidence: evidenceFor(records, { approvedBy: "" }) }, "approvedBy");
    rejects(
      { records, evidence: evidenceFor(records, { approvedAt: "2026-02-30" }) },
      "approvedAt",
    );
    rejects(
      { records, evidence: evidenceFor(records, { approvedAt: "26-07-2026" }) },
      "approvedAt",
    );
  });

  it("rejects a stable rule id list that drops, adds, or duplicates an id", () => {
    const records = approvedRecords();
    const stableRuleIds = ruleIdsByMaturity(records, "stable");

    rejects(
      {
        records,
        evidence: evidenceFor(records, { approvedStableRuleIds: stableRuleIds.slice(1) }),
      },
      "must exactly equal the current rule ids",
    );
    rejects(
      {
        records,
        evidence: evidenceFor(records, {
          approvedStableRuleIds: [...stableRuleIds, "zzz/not-a-rule"],
        }),
      },
      "must exactly equal the current rule ids",
    );
    rejects(
      {
        records,
        evidence: evidenceFor(records, {
          approvedStableRuleIds: [stableRuleIds[0], ...stableRuleIds],
        }),
      },
      `contains duplicate ${stableRuleIds[0]}`,
    );
  });

  it("rejects an experimental rule id listed as approved stable", () => {
    const records = approvedRecords();
    const stableRuleIds = ruleIdsByMaturity(records, "stable");

    rejects(
      {
        records,
        evidence: evidenceFor(records, {
          approvedStableRuleIds: [EXPERIMENTAL_RULE_ID, ...stableRuleIds].sort(),
        }),
      },
      "approvedStableRuleIds must exactly equal the current rule ids",
    );
  });

  it("rejects a reviewed experimental list that drops an id", () => {
    const records = approvedRecords();

    rejects(
      {
        records,
        evidence: evidenceFor(records, {
          reviewedExperimentalRuleIds: [EXPERIMENTAL_RULE_ID],
        }),
      },
      "reviewedExperimentalRuleIds must exactly equal the current rule ids",
    );
  });

  it("rejects rule id lists that are not in canonical code-point order", () => {
    const records = approvedRecords();

    rejects(
      {
        records,
        evidence: evidenceFor(records, {
          approvedStableRuleIds: ruleIdsByMaturity(records, "stable").reverse(),
        }),
      },
      "must be sorted in canonical code-point order",
    );
  });

  it("rejects a stable record that is still prepared", () => {
    const records = approvedRecords((fixture) => {
      const rule = ruleOf(fixture, STABLE_RULE_ID);
      rule.status = "prepared";
      delete rule.approvedBy;
      delete rule.approvedAt;
    });

    rejects({ records }, `review ${STABLE_RULE_ID} must be maintainer-approved`);
  });

  it("rejects a stable record whose approval identity or date differs from the evidence", () => {
    const identity = approvedRecords((fixture) => {
      ruleOf(fixture, STABLE_RULE_ID).approvedBy = "someone-else";
    });
    const date = approvedRecords((fixture) => {
      ruleOf(fixture, STABLE_RULE_ID).approvedAt = "2026-07-25";
    });

    rejects({ records: identity }, `review ${STABLE_RULE_ID}.approvedBy must equal`);
    rejects({ records: date }, `review ${STABLE_RULE_ID}.approvedAt must equal`);
  });

  it("rejects an experimental record that was approved", () => {
    const records = approvedRecords((fixture) => {
      const rule = ruleOf(fixture, EXPERIMENTAL_RULE_ID);
      rule.status = "maintainer-approved";
      rule.approvedBy = APPROVED_BY;
      rule.approvedAt = APPROVED_AT;
    });

    rejects({ records }, `review ${EXPERIMENTAL_RULE_ID} must remain prepared`);
  });

  it("rejects an experimental record that carries approval fields while prepared", () => {
    const records = approvedRecords((fixture) => {
      const rule = ruleOf(fixture, EXPERIMENTAL_RULE_ID);
      rule.approvedBy = APPROVED_BY;
      rule.approvedAt = APPROVED_AT;
    });

    rejects({ records }, `review ${EXPERIMENTAL_RULE_ID} must not contain approval fields`);
  });

  it("rejects an experimental rule that is default-on at runtime", () => {
    const rules = runtimeRules().map((rule) =>
      rule.id === EXPERIMENTAL_RULE_ID ? { ...rule, defaultEnabled: true } : rule,
    );

    rejects(
      { runtimeRules: rules },
      `review ${EXPERIMENTAL_RULE_ID} must remain experimental and default-off at runtime`,
    );
  });

  it("rejects an acknowledged uncovered scenario count that drifted", () => {
    const records = approvedRecords();

    rejects(
      { records, evidence: evidenceFor(records, { acknowledgedUncoveredScenarioCount: 12 }) },
      "acknowledgedUncoveredScenarioCount must equal the current count 13",
    );
  });

  it("rejects an open review exception count that drifted", () => {
    const records = approvedRecords((fixture) => {
      ruleOf(fixture, STABLE_RULE_ID).reviewExceptions = [
        {
          id: "bundled-consent-open-exception",
          scope: "corpus",
          status: "open",
          owner: "maintainer-review",
          reason: "Synthetic open exception used to exercise the count contract.",
          resolutionCriteria: "Close the exception or record an approved disposition.",
        },
      ];
    });

    rejects(
      { records, evidence: evidenceFor(records, { openReviewExceptionCount: 0 }) },
      "openReviewExceptionCount must equal the current count 1",
    );
  });
});

describe("maintainer approval policy defaults", () => {
  const PRODUCTION_POLICY = {};

  function productionCase(overrides: MutableFixture = {}, approver = PRODUCTION_APPROVER) {
    const records = approvedRecords(undefined, approver);
    return {
      records,
      evidence: evidenceFor(records, {
        approvedBy: approver,
        approvalTargetCommit: PRODUCTION_TARGET_COMMIT,
        ...overrides,
      }),
      policy: PRODUCTION_POLICY,
    };
  }

  it("accepts the P13 maintainer and the Stage A approval target", () => {
    const result = validate(productionCase());

    expect(result.errors).toEqual([]);
    expect(result.summary).toMatchObject({
      ok: true,
      approvedBy: PRODUCTION_APPROVER,
      approvalTargetCommit: PRODUCTION_TARGET_COMMIT,
    });
  });

  it("rejects another identity even when every stable record agrees with it", () => {
    rejects(
      productionCase({}, "attacker"),
      `approvedBy must equal the expected maintainer ${PRODUCTION_APPROVER}`,
    );
  });

  it("rejects the fixture approver the parameterized cases rely on", () => {
    rejects(
      productionCase({}, APPROVED_BY),
      `approvedBy must equal the expected maintainer ${PRODUCTION_APPROVER}`,
    );
  });

  it("rejects a well-formed commit SHA that is not the Stage A target", () => {
    const message = `approvalTargetCommit must equal the approved Stage A target ${PRODUCTION_TARGET_COMMIT}`;

    rejects(productionCase({ approvalTargetCommit: "0".repeat(40) }), message);
    rejects(productionCase({ approvalTargetCommit: APPROVAL_TARGET_COMMIT }), message);
  });
});
