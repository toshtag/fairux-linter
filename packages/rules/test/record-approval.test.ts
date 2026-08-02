import { describe, expect, it } from "vitest";
import reviewRecords from "../reviews/built-in-rule-reviews.json" with { type: "json" };
import sourceCatalog from "../reviews/official-sources.json" with { type: "json" };
import {
  approveRecords,
  buildApprovalPacket,
  measureApprovalFacts,
} from "../scripts/record-approval.mjs";
import { validateApprovalEvidence } from "../scripts/review-approval-validation.mjs";
import { collectRuntimeRuleMetadata } from "../scripts/review-validation.mjs";
import { fairuxBuiltinRulePack } from "../src/index.js";

const APPROVAL = {
  approvalTargetCommit: "b".repeat(40),
  approvedBy: "toshtag",
  approvedAt: "2026-08-02",
  workflowRunUrl: "https://github.com/toshtag/fairux-linter/actions/runs/123456",
};

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/**
 * What the approval workflow writes, tested without a workflow.
 *
 * The flow this replaced had a person copy six values between GitHub and a JSON file. The reason to
 * move that into code is that code can be tested; these are the tests that make the move worth it.
 */
describe("recording an approval", () => {
  it("measures the facts from the built packages rather than from the records alone", async () => {
    const facts = await measureApprovalFacts();
    expect(facts.reviewContentSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(facts.detectionDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(facts.approvedStableRuleIds.length).toBeGreaterThan(0);
    // Every stable rule appears with the version the build carries, not the version a record claims.
    const runtime = new Map(
      fairuxBuiltinRulePack.rules.map((rule) => [rule.meta.id, rule.meta.version]),
    );
    for (const entry of facts.approvedRules) {
      expect(runtime.get(entry.ruleId), entry.ruleId).toBe(entry.ruleVersion);
    }
  });

  it("builds a packet the gate accepts, beside the records it stamps", async () => {
    // Both halves, because either alone is rejected: the packet says one approval happened and each
    // stable record says it is covered by that one.
    const facts = await measureApprovalFacts();
    const result = validateApprovalEvidence({
      approvalEvidence: buildApprovalPacket(facts, APPROVAL),
      sourceCatalog: clone(sourceCatalog),
      reviewRecords: approveRecords(clone(reviewRecords), APPROVAL),
      runtimeRules: collectRuntimeRuleMetadata([
        ...fairuxBuiltinRulePack.rules,
        ...(fairuxBuiltinRulePack.journeyRules ?? []),
      ]),
      detectionDigest: facts.detectionDigest,
    });
    expect(result.errors).toEqual([]);
    expect(result.summary.type).toBe("github-environment-review");
  });

  it("writes a stable byte sequence for the same repository state", async () => {
    const first = buildApprovalPacket(await measureApprovalFacts(), APPROVAL);
    const second = buildApprovalPacket(await measureApprovalFacts(), APPROVAL);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  it("stamps every stable record, not only the one that changed", () => {
    const records = clone(reviewRecords) as {
      rules: { ruleId: string; maturity: string; status: string; approvedBy?: string }[];
    };
    // One prepared, the rest already approved at an older date. Stamping only the prepared one
    // would leave the others disagreeing with the packet, which is what the gate checks.
    const first = records.rules[0];
    if (!first) throw new Error("fixture has no rules");
    first.status = "prepared";
    const before = records.rules.filter((rule) => rule.maturity === "experimental").length;

    const approved = approveRecords(records, APPROVAL) as typeof records;
    for (const rule of approved.rules) {
      if (rule.maturity === "stable") {
        expect(rule.status, rule.ruleId).toBe("maintainer-approved");
        expect(rule.approvedBy).toBe("toshtag");
      } else {
        // An experimental record stays prepared and default-off; approving one is a different act.
        expect(rule.status, rule.ruleId).not.toBe("maintainer-approved");
      }
    }
    expect(approved.rules.filter((rule) => rule.maturity === "experimental").length).toBe(before);
  });

  it("does not invent an approver, a date, or a target commit", () => {
    // Every one of them arrives as an argument. A default here would be a fabricated approval that
    // read as a measured one, which is the whole failure this flow exists to prevent.
    const packet = buildApprovalPacket(
      {
        reviewContentSha256: "a".repeat(64),
        detectionDigest: "c".repeat(64),
        approvedStableRuleIds: ["x/y"],
        reviewedExperimentalRuleIds: [],
        approvedRules: [{ ruleId: "x/y", ruleVersion: "1.0.0" }],
        acknowledgedUncoveredScenarioCount: 0,
        openReviewExceptionCount: 0,
        preparedRuleIds: ["x/y"],
      },
      APPROVAL,
    ) as Record<string, unknown>;
    expect(packet.approvedBy).toBe(APPROVAL.approvedBy);
    expect(packet.approvedAt).toBe(APPROVAL.approvedAt);
    expect(packet.approvalTargetCommit).toBe(APPROVAL.approvalTargetCommit);
    expect(packet.workflowRunUrl).toBe(APPROVAL.workflowRunUrl);
    expect(packet.type).toBe("github-environment-review");
  });
});
