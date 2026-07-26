import { describe, expect, it } from "vitest";
import { allRules, experimentalRules } from "../src/index.js";
import { run } from "./_util.js";
import executionContract from "./fixtures/built-in-rule-execution-contract.json" with {
  type: "json",
};

const samples = {
  "consent-default": {
    html: `<html><body><h1>Cookie consent</h1><label><input type="checkbox" checked> Email me marketing offers</label><p>We use cookies.</p><button>Accept all</button></body></html>`,
    options: {},
  },
  "checkout-default": {
    html: `<html><body><h1>Checkout</h1><p>$49.00</p><button>Place order</button></body></html>`,
    options: {},
  },
  experimental: {
    html: `<html><body><p>We use cookies.</p><button class="btn-primary">Accept</button><a href="#" class="link">Reject</a><div class="modal"><p>Offer</p><button class="close" style="opacity:0.2">x</button></div></body></html>`,
    options: { includeExperimental: true },
  },
} as const;

function executionMetaContract() {
  return allRules.map((rule) => ({
    id: rule.meta.id,
    title: rule.meta.title,
    category: rule.meta.category,
    version: rule.meta.version,
    defaultSeverity: rule.meta.defaultSeverity,
    defaultConfidence: rule.meta.defaultConfidence,
    defaultEnabled: rule.meta.defaultEnabled,
    experimental: rule.meta.experimental === true,
    maturity: rule.meta.maturity,
    tags: rule.meta.tags,
    appliesTo: rule.meta.appliesTo ?? [],
    appliesToMinConfidence: rule.meta.appliesToMinConfidence ?? null,
    requiredCapabilities: rule.meta.requiredCapabilities,
    evidenceRequirements: rule.meta.evidenceRequirements,
  }));
}

describe("built-in rule behavior contract", () => {
  it("keeps rule order, default enablement, experimental rules, and non-governance metadata stable", () => {
    expect(allRules.map((rule) => rule.meta.id)).toEqual(executionContract.ruleOrder);
    expect(
      allRules.filter((rule) => rule.meta.defaultEnabled !== false).map((rule) => rule.meta.id),
    ).toEqual(executionContract.defaultEnabledRuleIds);
    expect(experimentalRules.map((rule) => rule.meta.id)).toEqual(
      executionContract.experimentalRuleIds,
    );
    expect(executionMetaContract()).toEqual(executionContract.rules);
  });

  it("preserves representative finding ids, counts, severity, confidence, and fingerprints", () => {
    for (const item of executionContract.representativeScans) {
      const sample = samples[item.name as keyof typeof samples];
      if (sample === undefined) throw new Error(`missing sample ${item.name}`);
      const report = run(sample.html, allRules, sample.options);
      expect(report.findings).toHaveLength(item.findingCount);
      expect(
        report.findings.map((finding) => ({
          id: finding.id,
          ruleId: finding.ruleId,
          severity: finding.severity,
          confidence: finding.confidence,
          fingerprint: finding.fingerprint,
        })),
      ).toEqual(item.findings);
    }
  });
});
