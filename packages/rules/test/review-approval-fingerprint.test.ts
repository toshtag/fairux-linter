import { describe, expect, it } from "vitest";
import reviewRecordsFixture from "../reviews/built-in-rule-reviews.json" with { type: "json" };
import sourceCatalogFixture from "../reviews/official-sources.json" with { type: "json" };
import { computeReviewApprovalFingerprint } from "../scripts/review-approval-fingerprint.mjs";

type MutableFixture = Record<string, unknown>;

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function mutableClone(value: unknown): MutableFixture {
  return clone(value) as MutableFixture;
}

function fingerprint(overrides: { sourceCatalog?: unknown; reviewRecords?: unknown }) {
  return computeReviewApprovalFingerprint({
    sourceCatalog: overrides.sourceCatalog ?? clone(sourceCatalogFixture),
    reviewRecords: overrides.reviewRecords ?? clone(reviewRecordsFixture),
  }).reviewContentSha256;
}

function stableRuleOf(records: MutableFixture): MutableFixture {
  const rules = records.rules as MutableFixture[];
  const stableRule = rules.find((rule) => rule.ruleId === "consent/bundled-consent");
  if (stableRule === undefined) throw new Error("missing consent/bundled-consent fixture");
  return stableRule;
}

function firstSourceReviewOf(rule: MutableFixture): MutableFixture {
  const sourceReviews = rule.officialSourceReviews as MutableFixture[];
  const firstSourceReview = sourceReviews[0];
  if (firstSourceReview === undefined) throw new Error("missing source review fixture");
  return firstSourceReview;
}

function withReviewException(records: MutableFixture, overrides: MutableFixture): MutableFixture {
  const stableRule = stableRuleOf(records);
  stableRule.reviewExceptions = [
    {
      id: "bundled-consent-review-exception",
      scope: "corpus",
      status: "open",
      owner: "maintainer-review",
      reason: "Prepared review scenario is not backed by an executable corpus test.",
      resolutionCriteria: "Add an executable corpus test or record an approved exception.",
      ...overrides,
    },
  ];
  return records;
}

describe("review approval fingerprint", () => {
  it("summarizes the prepared built-in review packet content", () => {
    const result = computeReviewApprovalFingerprint({
      sourceCatalog: clone(sourceCatalogFixture),
      reviewRecords: clone(reviewRecordsFixture),
    });

    expect(result).toEqual({
      schemaVersion: 1,
      ruleCount: 13,
      stableRuleCount: 11,
      experimentalRuleCount: 2,
      uncoveredScenarioCount: 15,
      openExceptionCount: 0,
      reviewContentSha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
    });
  });

  it("does not change when only rule approval metadata changes", () => {
    const records = mutableClone(reviewRecordsFixture);
    const stableRule = stableRuleOf(records);
    stableRule.status = "maintainer-approved";
    stableRule.approvedBy = "Maintainer <maintainer@example.com>";
    stableRule.approvedAt = "2026-07-26";

    expect(fingerprint({ reviewRecords: records })).toBe(fingerprint({}));
  });

  it("does not change when only review exception approval metadata changes", () => {
    const prepared = withReviewException(mutableClone(reviewRecordsFixture), {});
    const approved = withReviewException(mutableClone(reviewRecordsFixture), {
      status: "maintainer-approved",
      approvedBy: "Maintainer <maintainer@example.com>",
      approvedAt: "2026-07-26",
    });

    expect(fingerprint({ reviewRecords: approved })).toBe(fingerprint({ reviewRecords: prepared }));
  });

  it("changes when review exception content changes", () => {
    const records = withReviewException(mutableClone(reviewRecordsFixture), {
      reason: "Changed substantive exception reason.",
    });

    expect(fingerprint({ reviewRecords: records })).not.toBe(
      fingerprint({ reviewRecords: withReviewException(mutableClone(reviewRecordsFixture), {}) }),
    );
  });

  it("changes when review source mapping content changes", () => {
    const records = mutableClone(reviewRecordsFixture);
    firstSourceReviewOf(stableRuleOf(records)).mappingNote = "Changed substantive mapping.";

    expect(fingerprint({ reviewRecords: records })).not.toBe(fingerprint({}));
  });

  it("changes when a source review date changes", () => {
    const records = mutableClone(reviewRecordsFixture);
    firstSourceReviewOf(stableRuleOf(records)).reviewedAt = "2099-01-01";

    expect(fingerprint({ reviewRecords: records })).not.toBe(fingerprint({}));
  });

  it("changes when preparation provenance changes", () => {
    const preparedBy = mutableClone(reviewRecordsFixture);
    stableRuleOf(preparedBy).preparedBy = "AI agent: other-agent";
    const preparedAt = mutableClone(reviewRecordsFixture);
    stableRuleOf(preparedAt).preparedAt = "2099-01-01";

    expect(fingerprint({ reviewRecords: preparedBy })).not.toBe(fingerprint({}));
    expect(fingerprint({ reviewRecords: preparedAt })).not.toBe(fingerprint({}));
  });

  it("changes when the review policy changes", () => {
    const status = mutableClone(reviewRecordsFixture);
    (status.reviewPolicy as MutableFixture).status = "maintainer-approved";
    const note = mutableClone(reviewRecordsFixture);
    (note.reviewPolicy as MutableFixture).note = "Approval event recorded in the pull request.";

    expect(fingerprint({ reviewRecords: status })).not.toBe(fingerprint({}));
    expect(fingerprint({ reviewRecords: note })).not.toBe(fingerprint({}));
  });

  it("changes when a schema version changes", () => {
    const records = mutableClone(reviewRecordsFixture);
    records.schemaVersion = 99;
    const sourceCatalog = mutableClone(sourceCatalogFixture);
    sourceCatalog.schemaVersion = 99;

    expect(fingerprint({ reviewRecords: records })).not.toBe(fingerprint({}));
    expect(fingerprint({ sourceCatalog })).not.toBe(fingerprint({}));
  });

  it("changes when official source publication status changes", () => {
    const sourceCatalog = mutableClone(sourceCatalogFixture);
    const sources = sourceCatalog.sources as MutableFixture[];
    const firstSource = sources[0];
    if (firstSource === undefined) throw new Error("missing official source fixture");
    const catalogMetadata = firstSource.catalogMetadata as MutableFixture;
    catalogMetadata.publicationStatus = "historical";

    expect(fingerprint({ sourceCatalog })).not.toBe(fingerprint({}));
  });

  it("does not change when input collection ordering changes", () => {
    const records = mutableClone(reviewRecordsFixture);
    const rules = records.rules as MutableFixture[];
    rules.reverse();
    for (const rule of rules) (rule.officialSourceReviews as MutableFixture[]).reverse();
    const sourceCatalog = mutableClone(sourceCatalogFixture);
    (sourceCatalog.sources as MutableFixture[]).reverse();

    expect(fingerprint({ reviewRecords: records, sourceCatalog })).toBe(fingerprint({}));
  });
});
