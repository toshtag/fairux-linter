import type { RiskIndexReport } from "@fairux/core";
import { describe, expect, it } from "vitest";
import { riskIndexSarifProperties, toRiskIndexMarkdown, toRiskIndexView } from "../src/index.js";

const base = {
  kind: "risk-index",
  versions: {
    schemaVersion: "0.1",
    modelVersion: null,
    rulePacks: [{ id: "@fairux/builtin", version: "0.1.0" }],
    toolVersion: "1.0.0",
  },
  generatedAt: "2026-01-01T00:00:00.000Z",
  coverage: {
    documents: 2,
    requiredCapabilities: [],
    missingCapabilities: [],
    rules: { total: 13, eligible: 11, executed: 9, skipped: 2 },
  },
  contributingFindings: [],
  limitations: ["A Risk Index is not a safety, legal, or compliance verdict."],
} as const;

const unsupported: RiskIndexReport = {
  ...base,
  status: "unsupported",
  score: null,
  confidence: null,
  reason: { code: "no-model", message: "no Risk Index model is implemented in this build" },
} as RiskIndexReport;

const insufficient: RiskIndexReport = {
  ...base,
  coverage: {
    ...base.coverage,
    requiredCapabilities: ["network"],
    missingCapabilities: ["network"],
  },
  status: "insufficient-coverage",
  score: null,
  confidence: null,
  reason: { code: "missing-capability", message: "requires network, which no input supplied" },
} as RiskIndexReport;

const scored: RiskIndexReport = {
  ...base,
  versions: { ...base.versions, modelVersion: "test-model/1" },
  status: "sufficient",
  score: 42,
  confidence: "medium",
} as RiskIndexReport;

/**
 * A renderer is where the invariant gets lost. One surface printing `0` for a null score undoes the
 * contract, and nothing about the output would look wrong.
 */
describe("no surface can invent a number", () => {
  for (const [name, report] of [
    ["unsupported", unsupported],
    ["insufficient coverage", insufficient],
  ] as const) {
    it(`shows no digit where a score would be, for ${name}`, () => {
      const view = toRiskIndexView(report);
      expect(view.score).toBeNull();
      expect(view.scorePlaceholder).not.toMatch(/\d/);
      expect(view.confidence).not.toMatch(/\d/);

      const markdown = toRiskIndexMarkdown(report);
      const scoreLine = markdown.split("\n").find((line) => line.startsWith("**Score:**")) ?? "";
      expect(scoreLine).not.toMatch(/\d/);
      expect(markdown).toContain("**Status:** Not scored");
    });
  }

  it("says why there is no score", () => {
    expect(toRiskIndexMarkdown(unsupported)).toContain("no Risk Index model is implemented");
    expect(toRiskIndexMarkdown(insufficient)).toContain("requires network");
    expect(toRiskIndexView(insufficient).reason).toBeDefined();
  });

  it("shows the number, and only then, when the report carries one", () => {
    const view = toRiskIndexView(scored);
    expect(view.score).toBe("42");
    expect(view.reason).toBeUndefined();
    const markdown = toRiskIndexMarkdown(scored);
    expect(markdown).toContain("**Score:** 42");
    expect(markdown).toContain("**Confidence:** medium");
    expect(markdown).toContain("**Status:** Scored");
  });
});

describe("what a rendered index always carries", () => {
  it("shows coverage beside the score, scored or not", () => {
    for (const report of [unsupported, insufficient, scored]) {
      const markdown = toRiskIndexMarkdown(report);
      expect(markdown).toContain("## Coverage");
      expect(markdown).toContain("**Rules:** 9 ran, 2 skipped, of 13");
    }
  });

  it("prints the limitations, every time", () => {
    for (const report of [unsupported, insufficient, scored]) {
      expect(toRiskIndexMarkdown(report)).toContain("## What this does not mean");
      expect(toRiskIndexMarkdown(report)).toContain("not a safety, legal, or compliance verdict");
    }
  });

  it("names the model, including when there is none", () => {
    expect(toRiskIndexMarkdown(unsupported)).toContain("**Model:** `none`");
    expect(toRiskIndexMarkdown(scored)).toContain("**Model:** `test-model/1`");
  });
});

describe("the index in SARIF", () => {
  it("is run-level property data, never a result", () => {
    const properties = riskIndexSarifProperties(scored) as {
      riskIndex: Record<string, unknown>;
    };
    expect(properties.riskIndex.score).toBe(42);
    expect(properties.riskIndex.modelVersion).toBe("test-model/1");
    // A score is not a finding. Inventing a result would put a number where a consumer expects an
    // alert with a location, and everything that counts results would count it.
    expect(properties).not.toHaveProperty("results");
    expect(JSON.stringify(properties)).not.toContain("ruleId");
  });

  it("keeps null as null for machines, where a human surface shows a dash", () => {
    const properties = riskIndexSarifProperties(unsupported) as {
      riskIndex: Record<string, unknown>;
    };
    expect(properties.riskIndex.score).toBeNull();
    expect(properties.riskIndex.confidence).toBeNull();
    expect(properties.riskIndex.status).toBe("unsupported");
    expect(properties.riskIndex.reason).toEqual(unsupported.reason);
  });

  it("carries the limitations into the machine-readable form too", () => {
    const properties = riskIndexSarifProperties(insufficient) as {
      riskIndex: { limitations: readonly string[] };
    };
    expect(properties.riskIndex.limitations.length).toBeGreaterThan(0);
  });
});
