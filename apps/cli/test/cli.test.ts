import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { FairUxReport } from "@fairux/core";
import { describe, expect, it } from "vitest";
import { scanFile } from "../src/scan-file.js";

const here = dirname(fileURLToPath(import.meta.url));
const example = (name: string): string => resolve(here, "../../../examples", name);

function scanJson(name: string, includeExperimental = false): FairUxReport {
  return JSON.parse(
    scanFile(example(name), { format: "json", includeExperimental }),
  ) as FairUxReport;
}

const ruleIds = (report: FairUxReport): string[] => report.findings.map((f) => f.ruleId);

describe("fairux scan (end-to-end on example pages)", () => {
  it("free-trial.html → free-trial + pre-checked consent findings", () => {
    const ids = ruleIds(scanJson("free-trial.html"));
    expect(ids).toContain("subscription/free-trial-without-renewal-disclosure");
    expect(ids).toContain("consent/checked-checkbox");
  });

  it("subscription.html → subscribe-without-cancellation + scarcity", () => {
    const ids = ruleIds(scanJson("subscription.html"));
    expect(ids).toContain("subscription/cta-without-cancellation-context");
    expect(ids).toContain("scarcity/scarcity-phrase");
  });

  it("consent-banner.html → pre-checked + missing reject", () => {
    const ids = ruleIds(scanJson("consent-banner.html"));
    expect(ids).toContain("consent/checked-checkbox");
    expect(ids).toContain("consent/missing-reject-option");
  });

  it("checkout.html → hidden cost + scarcity + modal-without-close", () => {
    const ids = ruleIds(scanJson("checkout.html"));
    expect(ids).toContain("hidden-cost/price-near-checkout-without-fee-disclosure");
    expect(ids).toContain("scarcity/scarcity-phrase");
    expect(ids).toContain("obstruction/modal-without-close-action");
  });

  it("emits a valid FairUxReport envelope as JSON (toolVersion flows through)", () => {
    const report = JSON.parse(
      scanFile(example("checkout.html"), { format: "json", toolVersion: "9.9.9" }),
    ) as FairUxReport;
    expect(report.schemaVersion).toBe("0.1");
    expect(report.toolVersion).toBe("9.9.9");
    expect(report.input.runtime).toBe("html");
    expect(report.summary.total).toBe(report.findings.length);
  });

  it("renders Markdown with the disclaimer", () => {
    const md = scanFile(example("checkout.html"), { format: "markdown" });
    expect(md).toContain("# FairUX Report");
    expect(md).toContain("FairUX does not provide legal judgments");
  });

  it("does not run experimental rules by default", () => {
    const ids = ruleIds(scanJson("consent-banner.html"));
    expect(ids).not.toContain("consent/accept-reject-visual-imbalance");
  });

  it("emits SARIF 2.1.0 with fairuxV1 fingerprints and the disclaimer (CI-friendly artifact)", () => {
    const text = scanFile(example("checkout.html"), {
      format: "sarif",
      toolVersion: "9.9.9",
    });
    const log = JSON.parse(text) as {
      version: string;
      $schema?: string;
      runs: Array<{
        tool: { driver: { name: string; version?: string; fullDescription?: { text: string } } };
        results: Array<{
          level: string;
          ruleId: string;
          fingerprints: Record<string, string>;
        }>;
      }>;
    };
    expect(log.version).toBe("2.1.0");
    expect(log.runs[0]?.tool.driver.name).toBe("FairUX");
    expect(log.runs[0]?.tool.driver.version).toBe("9.9.9");
    expect(log.runs[0]?.tool.driver.fullDescription?.text).toContain("not provide legal judgments");
    // Every result must carry the versioned fingerprint key (the cross-runtime baseline anchor).
    for (const result of log.runs[0]?.results ?? []) {
      expect(result.fingerprints.fairuxV1).toMatch(/^[0-9a-f]{16}$/);
    }
  });
});
