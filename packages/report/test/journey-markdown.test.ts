import type { Finding, JourneyReport, ScanCoverage } from "@fairux/core";
import { describe, expect, it } from "vitest";
import { toJourneyMarkdown } from "../src/index.js";
import { sampleCoverage, sampleReport } from "./_fixture.js";

const noJourneyRules: ScanCoverage = {
  capabilities: { available: ["structure", "text", "journey"], unavailable: ["network"] },
  summary: { total: 0, eligible: 0, executed: 0, skipped: 0 },
  rules: [],
};

const oneJourneyRule: ScanCoverage = {
  capabilities: { available: ["structure", "text", "journey"], unavailable: ["network"] },
  summary: { total: 1, eligible: 1, executed: 1, skipped: 0 },
  rules: [{ ruleId: "fixtures/price-changed", executed: true }],
};

const crossStepFinding: Finding = {
  id: "fixtures/price-changed#0",
  fingerprint: "9999999999999999",
  ruleId: "fixtures/price-changed",
  category: "hidden-cost",
  severity: "high",
  confidence: "medium",
  title: "The price changed between steps",
  description: "The price shown was $19.00 and later $29.00.",
  evidence: [
    { stepId: "pricing", text: "$19.00" },
    { stepId: "checkout", text: "$29.00" },
  ],
  whyItMatters: "A commitment that changes between steps may surprise a user at payment.",
  recommendation: "Show the same total at every step.",
};

function journey(over: Partial<JourneyReport> = {}): JourneyReport {
  return {
    kind: "journey",
    schemaVersion: "0.1",
    toolVersion: "1.0.0",
    generatedAt: "2026-01-01T00:00:00.000Z",
    steps: [
      { id: "pricing", order: 1, url: "/pricing", report: { ...sampleReport, findings: [] } },
      {
        id: "checkout",
        order: 2,
        url: "/checkout",
        report: { ...sampleReport, coverage: sampleCoverage },
      },
    ],
    findings: [],
    summary: { total: 0, bySeverity: { info: 0, low: 0, medium: 0, high: 0 } },
    stepSummary: { total: 3, bySeverity: { info: 0, low: 1, medium: 1, high: 1 } },
    coverage: noJourneyRules,
    ...over,
  };
}

describe("rendering a journey", () => {
  it("names both layers and says how they relate, rather than leaving a reader to guess", () => {
    const markdown = toJourneyMarkdown(
      journey({
        findings: [crossStepFinding],
        summary: { total: 1, bySeverity: { info: 0, low: 0, medium: 0, high: 1 } },
        coverage: oneJourneyRule,
      }),
    );
    expect(markdown).toContain("**Across the flow:** 1 (high: 1");
    expect(markdown).toContain("**Within steps:** 3 (high: 1");
    expect(markdown).toContain("**Total:** 4");
    expect(markdown).toContain("No finding appears in both, so the total below is their sum.");
  });

  it("keeps the two layers in separate sections, never in one severity-sorted list", () => {
    const markdown = toJourneyMarkdown(
      journey({
        findings: [crossStepFinding],
        summary: { total: 1, bySeverity: { info: 0, low: 0, medium: 0, high: 1 } },
        coverage: oneJourneyRule,
      }),
    );
    const flow = markdown.indexOf("## Across the flow");
    const firstStep = markdown.indexOf("## Step 1: `pricing`");
    const secondStep = markdown.indexOf("## Step 2: `checkout`");
    expect(flow).toBeGreaterThan(-1);
    expect(firstStep).toBeGreaterThan(flow);
    expect(secondStep).toBeGreaterThan(firstStep);
    // The cross-step finding appears once, under the flow, and not repeated into a step.
    expect(markdown.split("The price changed between steps")).toHaveLength(2);
  });

  it("distinguishes a flow nothing checked from a flow nothing was found in", () => {
    // Both produce `Across the flow: 0`, and they mean opposite things. This is the one place a
    // reader could take an absent check for a clean result.
    const unchecked = toJourneyMarkdown(journey());
    expect(unchecked).toContain("**Nothing was checked here.**");
    expect(unchecked).toContain("the absence of a check, not a clean result");

    const checked = toJourneyMarkdown(journey({ coverage: oneJourneyRule }));
    expect(checked).not.toContain("**Nothing was checked here.**");
    expect(checked).toContain("No cross-step findings.");
  });

  it("anchors a cross-step finding's evidence to its step, ahead of the locator", () => {
    const markdown = toJourneyMarkdown(
      journey({
        findings: [crossStepFinding],
        summary: { total: 1, bySeverity: { info: 0, low: 0, medium: 0, high: 1 } },
        coverage: oneJourneyRule,
      }),
    );
    expect(markdown).toContain('- step `pricing` — "$19.00"');
    expect(markdown).toContain('- step `checkout` — "$29.00"');
  });

  it("gives every step its own coverage, and never rolls them into the flow's", () => {
    const markdown = toJourneyMarkdown(journey());
    expect(markdown).toContain("## Coverage across the flow");
    expect(markdown).toContain("### Coverage");
    // The journey's coverage is what the journey rules could check — not the union of the steps'.
    expect(markdown.indexOf("## Coverage across the flow")).toBeLessThan(
      markdown.indexOf("## Step 1"),
    );
  });

  it("still carries the disclaimer, like every other rendering", () => {
    expect(toJourneyMarkdown(journey())).toContain("FairUX does not provide legal judgments");
  });
});
