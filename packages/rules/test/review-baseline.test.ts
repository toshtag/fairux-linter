import { describe, expect, it } from "vitest";
import baselineFixture from "../reviews/rule-review-baseline.json" with { type: "json" };
import {
  buildReviewBaseline,
  serializeReviewBaseline,
  validateReviewBaseline,
} from "../scripts/review-baseline.mjs";
import { collectRuntimeRuleMetadata } from "../scripts/review-validation.mjs";
import { measureReviewBaseline } from "../scripts/update-review-baseline.mjs";
import { fairuxBuiltinRulePack } from "../src/index.js";

const runtimeRules = collectRuntimeRuleMetadata(fairuxBuiltinRulePack.rules);
const current = {
  reviewContentSha256: baselineFixture.reviewContentSha256,
  detectionDigest: baselineFixture.detectionDigest,
};

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function validate(baseline: unknown) {
  return validateReviewBaseline({ baseline, current, runtimeRules });
}

/**
 * What replaced a protected environment, a workflow dispatch, and a human approval event.
 *
 * A rule change is an ordinary code change. What has to be true is that the change was made
 * deliberately — a version moved, a review record says why, and the two hashes agree with the build.
 * None of that needs a person to click anything, and these are the cases that make that claim
 * checkable rather than asserted.
 */
describe("the review baseline", () => {
  it("describes the repository as it is checked in", () => {
    expect(validate(clone(baselineFixture)).errors).toEqual([]);
  });

  it("is exactly what the update command would write", async () => {
    // The command and the check share one implementation, so a stale baseline is a diff and never a
    // disagreement about how the value is computed.
    const measured = await measureReviewBaseline();
    expect(serializeReviewBaseline(measured)).toBe(serializeReviewBaseline(clone(baselineFixture)));
  });

  it("refuses a detection change that did not move the digest", () => {
    const stale = clone(baselineFixture);
    stale.detectionDigest = "a".repeat(64);
    const result = validate(stale);
    expect(result.ok).toBe(false);
    // And says which command fixes it, rather than naming a person to go and ask.
    expect(result.errors.join("\n")).toContain("the rules now detect");
    expect(result.errors.join("\n")).toContain("ruleVersion bump");
  });

  it("refuses a review record edit that did not move the fingerprint", () => {
    const stale = clone(baselineFixture);
    stale.reviewContentSha256 = "b".repeat(64);
    expect(validate(stale).errors.join("\n")).toContain("review records now hash to");
  });

  it("refuses to answer at all when a hash is not a hash", () => {
    // Comparing a malformed value against a real one reports "detection changed", which reads as a
    // finding and is not one.
    const broken = clone(baselineFixture);
    broken.detectionDigest = "not-a-digest";
    const errors = validate(broken).errors.join("\n");
    expect(errors).toContain("must be a lowercase SHA-256");
    expect(errors).not.toContain("the rules now detect");
  });

  it("notices a version the build does not ship, in both directions", () => {
    const drifted = clone(baselineFixture);
    const first = drifted.rules[0];
    if (!first) throw new Error("baseline has no rules");
    first.ruleVersion = "99.0.0";
    expect(validate(drifted).errors.join("\n")).toContain("but the rule pack ships");

    const missing = clone(baselineFixture);
    missing.rules = missing.rules.slice(1);
    expect(validate(missing).errors.join("\n")).toContain("missing from the review baseline");
  });

  it("carries no approver, no date, and no workflow run", () => {
    // The point of the change: correctness is what the baseline records, and none of these say
    // anything about it.
    const text = JSON.stringify(baselineFixture);
    for (const forbidden of [
      "approvedBy",
      "approvedAt",
      "workflowRunUrl",
      "environment",
      "approvalTargetCommit",
    ]) {
      expect(text, forbidden).not.toContain(forbidden);
    }
    expect(Object.keys(baselineFixture).sort()).toEqual([
      "detectionDigest",
      "reviewContentSha256",
      "rules",
      "schemaVersion",
    ]);
  });

  it("lists only the stable rules, sorted, with no duplicates", () => {
    const built = buildReviewBaseline({
      reviewContentSha256: "c".repeat(64),
      detectionDigest: "d".repeat(64),
      reviewRecords: {
        rules: [
          { ruleId: "b/two", ruleVersion: "1.0.0", maturity: "stable" },
          { ruleId: "a/one", ruleVersion: "2.1.0", maturity: "stable" },
          // Experimental rules are default-off and not part of what the baseline pins.
          { ruleId: "c/three", ruleVersion: "0.1.0", maturity: "experimental" },
        ],
      },
    });
    expect(built.rules).toEqual([
      { ruleId: "a/one", ruleVersion: "2.1.0" },
      { ruleId: "b/two", ruleVersion: "1.0.0" },
    ]);
  });
});
