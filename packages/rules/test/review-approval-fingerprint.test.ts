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
      uncoveredScenarioCount: 13,
      openExceptionCount: 0,
      reviewContentSha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
    });
  });

  it("does not change when only approval metadata changes", () => {
    const records = mutableClone(reviewRecordsFixture);
    const rules = records.rules as MutableFixture[];
    const stableRule = rules.find((rule) => rule.ruleId === "consent/bundled-consent");
    if (stableRule === undefined) throw new Error("missing consent/bundled-consent fixture");
    stableRule.status = "maintainer-approved";
    stableRule.approvedBy = "Maintainer <maintainer@example.com>";
    stableRule.approvedAt = "2026-07-26";
    const reviewPolicy = records.reviewPolicy as MutableFixture;
    reviewPolicy.note = "Approval event recorded in the pull request.";

    expect(fingerprint({ reviewRecords: records })).toBe(fingerprint({}));
  });

  it("changes when review source mapping content changes", () => {
    const records = mutableClone(reviewRecordsFixture);
    const rules = records.rules as MutableFixture[];
    const stableRule = rules.find((rule) => rule.ruleId === "consent/bundled-consent");
    if (stableRule === undefined) throw new Error("missing consent/bundled-consent fixture");
    const sourceReviews = stableRule.officialSourceReviews as MutableFixture[];
    const firstSourceReview = sourceReviews[0];
    if (firstSourceReview === undefined) throw new Error("missing source review fixture");
    firstSourceReview.mappingNote = "Changed substantive mapping.";

    expect(fingerprint({ reviewRecords: records })).not.toBe(fingerprint({}));
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
});
