import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type FairUxBatchReport,
  type FairUxReport,
  InputTooLargeError,
  MAX_INPUT_BYTES,
} from "@fairux/core";
import { describe, expect, it } from "vitest";
import {
  BatchLimitError,
  isScannableExtension,
  MAX_BATCH_FILES,
  MAX_BATCH_FINDINGS,
  readUtf8FileBounded,
  renderReport,
  scanFileReport,
  scanFiles,
  scanFilesReport,
  scanSource,
  shouldFailOn,
  toStableReportPath,
} from "../src/scan-file.js";

const here = dirname(fileURLToPath(import.meta.url));
const example = (name: string): string => resolve(here, "../../../examples", name);

describe("isScannableExtension", () => {
  it("accepts .html, .htm, .tsx, .jsx, .ts, .js, .figjson", () => {
    expect(isScannableExtension(".html")).toBe(true);
    expect(isScannableExtension(".htm")).toBe(true);
    expect(isScannableExtension(".tsx")).toBe(true);
    expect(isScannableExtension(".jsx")).toBe(true);
    expect(isScannableExtension(".ts")).toBe(true);
    expect(isScannableExtension(".js")).toBe(true);
    expect(isScannableExtension(".figjson")).toBe(true);
  });

  it("rejects unsupported extensions", () => {
    expect(isScannableExtension(".css")).toBe(false);
    expect(isScannableExtension(".json")).toBe(false);
    expect(isScannableExtension(".md")).toBe(false);
  });
});

describe("shouldFailOn", () => {
  const makeReport = (severities: string[]): FairUxReport =>
    ({
      schemaVersion: "0.1",
      toolVersion: "test",
      generatedAt: "2025-01-01T00:00:00.000Z",
      input: { runtime: "html" },
      summary: {
        total: severities.length,
        bySeverity: { info: 0, low: 0, medium: 0, high: 0 },
      },
      findings: severities.map((s, i) => ({
        id: `F${i + 1}`,
        ruleId: "test/rule",
        title: "Test",
        description: "Test",
        recommendation: "Test",
        severity: s as "high" | "medium" | "low" | "info",
        confidence: "high" as const,
        category: "consent" as const,
        evidence: [],
        fingerprint: "abcd1234",
        whyItMatters: "test",
      })),
    }) as unknown as FairUxReport;

  it("fails when a high finding meets the high threshold", () => {
    expect(shouldFailOn(makeReport(["high"]), "high")).toBe(true);
  });

  it("fails when a medium finding meets the medium threshold", () => {
    expect(shouldFailOn(makeReport(["medium"]), "medium")).toBe(true);
  });

  it("does not fail when only info findings and threshold is low", () => {
    expect(shouldFailOn(makeReport(["info"]), "low")).toBe(false);
  });

  it("fails when high finding exceeds medium threshold", () => {
    expect(shouldFailOn(makeReport(["high"]), "medium")).toBe(true);
  });

  it("does not fail on empty report", () => {
    expect(shouldFailOn(makeReport([]), "info")).toBe(false);
  });
});

describe("scanSource (stdin)", () => {
  it("scans HTML from a source string", () => {
    const html = "<button>Buy now</button>";
    const output = scanSource(html, "stdin.html", { format: "json" });
    const report = JSON.parse(output) as FairUxReport;
    expect(report.schemaVersion).toBe("0.1");
    expect(report.input.runtime).toBe("html");
  });

  it("scans JSX from a source string with .tsx label", () => {
    const tsx = "export const Button = () => <button>Buy now</button>";
    const output = scanSource(tsx, "stdin.tsx", { format: "json" });
    const report = JSON.parse(output) as FairUxReport;
    expect(report.input.runtime).toBe("ast");
  });
});

describe("portable report paths", () => {
  it("normalizes only the host separator for report paths", () => {
    expect(toStableReportPath("src\\pages\\checkout.tsx", process.cwd(), "\\")).toBe(
      "src/pages/checkout.tsx",
    );
    expect(toStableReportPath("src\\pages\\checkout.tsx", process.cwd(), "/")).toBe(
      "src\\pages\\checkout.tsx",
    );
  });

  it("keeps AST fingerprints stable across checkout roots", () => {
    const originalCwd = process.cwd();
    const rootA = mkdtempSync(join(tmpdir(), "fairux-checkout-a-"));
    const rootB = mkdtempSync(join(tmpdir(), "fairux-checkout-b-"));
    try {
      const rel = join("src", "pages", "checkout.tsx");
      for (const root of [rootA, rootB]) {
        const file = join(root, rel);
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(
          file,
          `export function Checkout() {
          return <label><input type="checkbox" checked /> Email me marketing offers</label>;
        }`,
          "utf8",
        );
      }

      process.chdir(rootA);
      const firstReport = scanFileReport(join(rootA, rel), {
        format: "json",
        toolVersion: "test",
      });
      process.chdir(rootB);
      const secondReport = scanFileReport(join(rootB, rel), {
        format: "json",
        toolVersion: "test",
      });
      const first = firstReport.findings.find((f) => f.ruleId === "consent/checked-checkbox");
      const second = secondReport.findings.find((f) => f.ruleId === "consent/checked-checkbox");
      expect(first).toBeDefined();
      expect(second).toBeDefined();
      expect(first?.fingerprint).toBe(second?.fingerprint);
      expect(first?.evidence[0]?.locator).toMatchObject({
        type: "ast",
        file: "src/pages/checkout.tsx",
      });
      expect(first?.evidence[0]?.source?.file).toBe("src/pages/checkout.tsx");
    } finally {
      process.chdir(originalCwd);
      rmSync(rootA, { recursive: true, force: true });
      rmSync(rootB, { recursive: true, force: true });
    }
  });

  it("emits encoded SARIF artifact URIs without collapsing POSIX literal backslashes", () => {
    const tmp = mkdtempSync(join(tmpdir(), "fairux-sarif-paths-"));
    try {
      const file = join(tmp, "checkout.tsx");
      writeFileSync(
        file,
        `export const Checkout = () =>
          <label><input type="checkbox" checked /> Email me marketing offers</label>;`,
        "utf8",
      );
      const report = scanFileReport(file, {
        format: "json",
        toolVersion: "test",
        reportPath: "src/component\\legacy#checkout?.tsx",
      });
      const sarif = JSON.parse(renderReport(report, "sarif"));
      const uri = sarif.runs[0].results[0].locations[0].physicalLocation.artifactLocation.uri;
      expect(uri).toBe("src/component%5Clegacy%23checkout%3F.tsx");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("reads UTF-8 files through the bounded reader", () => {
    const tmp = mkdtempSync(join(tmpdir(), "fairux-bounded-"));
    try {
      const empty = join(tmp, "empty.html");
      writeFileSync(empty, "", "utf8");
      expect(readUtf8FileBounded(empty, 1)).toEqual({ source: "", byteLength: 0 });

      const over = join(tmp, "over.html");
      writeFileSync(over, "abcd", "utf8");
      expect(() => readUtf8FileBounded(over, 3)).toThrow(InputTooLargeError);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("rejects non-regular files through the bounded reader", () => {
    const tmp = mkdtempSync(join(tmpdir(), "fairux-bounded-nonregular-"));
    try {
      expect(() => readUtf8FileBounded(tmp, MAX_INPUT_BYTES)).toThrow(/Not a file/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("scanFiles (multi-file merge)", () => {
  it("merges two HTML files into one report with unique finding IDs", () => {
    const output = scanFiles([example("checkout.html"), example("consent-banner.html")], {
      format: "json",
      toolVersion: "test",
    });
    const report = JSON.parse(output) as FairUxBatchReport;
    expect(report.reports.length).toBeGreaterThan(0);
    const allFindings = report.reports.flatMap((r) => r.findings);
    expect(allFindings.length).toBeGreaterThan(0);
    const ids = allFindings.map((f) => f.id);
    const uniqueIds = new Set(ids);
    expect(ids.length).toBe(uniqueIds.size);
  });

  it("uses relative paths in report metadata", () => {
    const output = scanFiles([example("checkout.html")], {
      format: "json",
      toolVersion: "test",
    });
    const report = JSON.parse(output) as FairUxBatchReport;
    expect(report.reports.length).toBeGreaterThan(0);
    const allFindings = report.reports.flatMap((r) => r.findings);
    expect(allFindings.length).toBeGreaterThan(0);
  });

  it("preserves stable fingerprints and adds batch occurrence IDs", () => {
    const tmp = mkdtempSync(join(tmpdir(), "fairux-batch-identity-"));
    try {
      const first = join(tmp, "first.html");
      const second = join(tmp, "nested", "second.html");
      mkdirSync(dirname(second), { recursive: true });
      const html =
        '<html><body><label><input type="checkbox" checked> Email me offers</label></body></html>';
      writeFileSync(first, html, "utf8");
      writeFileSync(second, html, "utf8");

      const single = scanFileReport(first, {
        format: "json",
        toolVersion: "test",
        reportPath: relative(process.cwd(), first),
      }).findings.find((f) => f.ruleId === "consent/checked-checkbox");
      expect(single).toBeDefined();

      const batch = JSON.parse(
        scanFiles([first, second], { format: "json", toolVersion: "test" }),
      ) as FairUxBatchReport;
      const findings = batch.reports
        .flatMap((r) => r.findings)
        .filter((f) => f.ruleId === "consent/checked-checkbox");

      expect(findings).toHaveLength(2);
      expect(findings.every((f) => f.fingerprint === single?.fingerprint)).toBe(true);
      expect(findings.every((f) => /^\d+:/.test(f.id))).toBe(true);
      expect(findings.every((f) => typeof f.batchOccurrenceId === "string")).toBe(true);
      expect(new Set(findings.map((f) => f.batchOccurrenceId)).size).toBe(2);
      expect(batch.summary.total).toBe(batch.reports.flatMap((r) => r.findings).length);
      expect(batch.inputs.map((input) => input.file)).toEqual(
        batch.reports.map((report) => report.input.file),
      );
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("applies shared scanner configuration to every batch file", () => {
    const tmp = mkdtempSync(join(tmpdir(), "fairux-batch-config-"));
    try {
      const first = join(tmp, "first.html");
      const second = join(tmp, "second.html");
      const html =
        `<main><label><input type="checkbox" checked> Email me offers</label>` +
        `<div role="dialog"><p>We use cookies.</p>` +
        `<button class="primary cta" style="font-weight:bold">Accept</button>` +
        `<button class="muted link" style="opacity:0.5">Reject</button></div></main>`;
      writeFileSync(first, html, "utf8");
      writeFileSync(second, html, "utf8");

      const report = scanFilesReport([first, second], {
        format: "json",
        toolVersion: "test",
        config: {
          includeExperimental: true,
          rules: { "consent/checked-checkbox": { severity: "low" } },
        },
      });

      const allFindings = report.reports.flatMap((r) => r.findings);
      expect(report.summary.total).toBe(allFindings.length);
      expect(report.reports).toHaveLength(2);
      expect(report.rulePacks?.map((pack) => pack.id)).toEqual(["@fairux/builtin"]);
      expect(
        report.reports.every((subReport) =>
          subReport.findings.some((f) => f.ruleId === "consent/accept-reject-visual-imbalance"),
        ),
      ).toBe(true);
      expect(
        allFindings
          .filter((f) => f.ruleId === "consent/checked-checkbox")
          .every((f) => f.severity === "low"),
      ).toBe(true);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("reports file count batch limit as files", () => {
    const files = Array.from({ length: MAX_BATCH_FILES + 1 }, (_, i) => `missing-${i}.html`);
    // Scanned once, then asked four questions. `error` stays `undefined` when nothing throws, and
    // `toBeInstanceOf` fails on that — so the guard `expect(...).toThrow()` gave is still here.
    let error: unknown;
    try {
      scanFilesReport(files, { format: "json", toolVersion: "test" });
    } catch (thrown) {
      error = thrown;
    }
    expect(error).toBeInstanceOf(BatchLimitError);
    expect((error as BatchLimitError).kind).toBe("files");
    expect((error as BatchLimitError).actual).toBe(MAX_BATCH_FILES + 1);
    expect((error as Error).message).not.toMatch(/nodes/i);
  });

  it("reports finding count batch limit as findings", () => {
    const tmp = mkdtempSync(join(tmpdir(), "fairux-finding-limit-"));
    try {
      const file = join(tmp, "many.html");
      const labels = Array.from(
        { length: MAX_BATCH_FINDINGS + 1 },
        (_, i) => `<label><input type="checkbox" checked> Email me offers ${i}</label>`,
      ).join("");
      writeFileSync(file, `<main>${labels}</main>`, "utf8");
      // Scanning a 10 001-finding page is most of this file's runtime, and it used to happen twice
      // for four assertions about one error.
      let error: unknown;
      try {
        scanFilesReport([file], { format: "json", toolVersion: "test" });
      } catch (thrown) {
        error = thrown;
      }
      expect(error).toBeInstanceOf(BatchLimitError);
      expect((error as BatchLimitError).kind).toBe("findings");
      expect((error as BatchLimitError).actual).toBe(MAX_BATCH_FINDINGS + 1);
      expect((error as Error).message).not.toMatch(/nodes/i);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }, 20_000);
});
