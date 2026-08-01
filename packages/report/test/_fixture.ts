import type { FairUxReport, ScanCoverage } from "@fairux/core";

/** A deterministic report covering high/medium/low so reporters can be snapshotted. */
export const sampleReport: FairUxReport = {
  kind: "single",
  schemaVersion: "0.1",
  toolVersion: "1.0.0",
  generatedAt: "2026-01-01T00:00:00.000Z",
  input: { file: "checkout.html", runtime: "html" },
  summary: { total: 3, bySeverity: { info: 0, low: 1, medium: 1, high: 1 } },
  findings: [
    {
      id: "subscription/free-trial-without-renewal-disclosure#0",
      fingerprint: "1111111111111111",
      ruleId: "subscription/free-trial-without-renewal-disclosure",
      category: "subscription",
      severity: "high",
      confidence: "medium",
      title: "Free trial CTA lacks renewal disclosure",
      description: "A free-trial call to action has no nearby auto-renewal or billing-start text.",
      evidence: [
        {
          locator: { type: "css", value: "#start-trial" },
          text: "Start free trial",
          source: { file: "checkout.html", startLine: 12 },
        },
      ],
      whyItMatters:
        "Users may read the action as free-only and miss that billing starts automatically later.",
      recommendation: "Place billing-start and cancellation terms next to the trial CTA.",
      references: ["https://www.ftc.gov/business-guidance/blog"],
    },
    {
      id: "consent/checked-checkbox#1",
      fingerprint: "2222222222222222",
      ruleId: "consent/checked-checkbox",
      category: "consent",
      severity: "medium",
      confidence: "high",
      title: "Pre-checked consent box",
      description: "A consent checkbox is checked by default.",
      evidence: [{ locator: { type: "css", value: "#newsletter" }, text: "Email me offers" }],
      whyItMatters: "Pre-checked boxes opt users in without an active choice.",
      recommendation: "Leave consent boxes unchecked by default.",
    },
    {
      id: "scarcity/scarcity-phrase#2",
      fingerprint: "3333333333333333",
      ruleId: "scarcity/scarcity-phrase",
      category: "scarcity",
      severity: "low",
      confidence: "low",
      title: "Scarcity phrasing detected",
      description: 'The text "Only 2 left!" may apply time/quantity pressure.',
      evidence: [{ text: "Only 2 left!", source: { file: "checkout.html", startLine: 30 } }],
      whyItMatters: "Unverified scarcity claims can pressure users into rushed decisions.",
      recommendation: "Show scarcity only when backed by real, current inventory data.",
    },
  ],
};

export const emptyReport: FairUxReport = {
  kind: "single",
  schemaVersion: "0.1",
  toolVersion: "1.0.0",
  generatedAt: "2026-01-01T00:00:00.000Z",
  input: { file: "clean.html", runtime: "html" },
  summary: { total: 0, bySeverity: { info: 0, low: 0, medium: 0, high: 0 } },
  findings: [],
};

export const externalCategoryReport: FairUxReport = {
  kind: "single",
  schemaVersion: "0.1",
  toolVersion: "1.0.0",
  generatedAt: "2026-01-01T00:00:00.000Z",
  input: { file: "checkout.html", runtime: "html" },
  rulePacks: [{ id: "@purchase-guard/jp-commerce", version: "0.1.0" }],
  summary: { total: 1, bySeverity: { info: 0, low: 1, medium: 0, high: 0 } },
  findings: [
    {
      id: "purchase-guard/missing-return-policy#0",
      fingerprint: "4444444444444444",
      ruleId: "purchase-guard/missing-return-policy",
      category: "purchase-guard/return-policy",
      severity: "low",
      confidence: "medium",
      title: "Missing return policy",
      description: "No return policy copy was found near the purchase flow.",
      evidence: [{ locator: { type: "css", value: "main" }, text: "Buy now" }],
      whyItMatters: "Return terms are a consumer-protection signal.",
      recommendation: "Link to the return policy before checkout.",
    },
  ],
};

/**
 * Coverage with something in every branch: one skip of each reason, and one rule that ran without an
 * optional capability. A fixture where every list is empty proves the section renders, not that it
 * renders anything worth reading.
 */
export const sampleCoverage: ScanCoverage = {
  capabilities: {
    available: ["structure", "text", "attributes", "source-location", "style-hints"],
    unavailable: ["dom-state", "computed-style", "viewport", "interaction", "journey", "network"],
  },
  summary: { total: 5, eligible: 4, executed: 2, skipped: 2 },
  rules: [
    { ruleId: "consent/checked-checkbox", executed: true },
    {
      ruleId: "obstruction/modal-close-visibility",
      executed: true,
      missingOptionalCapabilities: ["computed-style", "viewport"],
    },
    {
      ruleId: "journey/cancellation-path",
      executed: false,
      skipReason: "missing-capability",
      missingCapabilities: ["journey"],
    },
    {
      ruleId: "hidden-cost/price-near-checkout-without-fee-disclosure",
      executed: false,
      skipReason: "page-context-mismatch",
    },
    {
      ruleId: "consent/accept-reject-visual-imbalance",
      executed: false,
      skipReason: "not-enabled",
    },
  ],
};

/** The case coverage exists for: nothing found, and not everything looked at. */
export const emptyReportWithCoverage: FairUxReport = {
  ...emptyReport,
  coverage: sampleCoverage,
};

export const sampleReportWithCoverage: FairUxReport = {
  ...sampleReport,
  coverage: sampleCoverage,
};
