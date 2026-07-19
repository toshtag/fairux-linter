import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
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
const cliBin = resolve(here, "../dist/index.js");
const example = (name: string): string => resolve(here, "../../../examples", name);

function runCli(args: string[], opts?: { stdin?: string; cwd?: string }): string {
  return execFileSync("node", [cliBin, ...args], {
    encoding: "utf8",
    input: opts?.stdin,
    cwd: opts?.cwd,
    timeout: 10000,
  });
}

function runCliResult(args: string[], opts?: { stdin?: string; cwd?: string }) {
  return spawnSync("node", [cliBin, ...args], {
    encoding: "utf8",
    input: opts?.stdin,
    cwd: opts?.cwd,
    timeout: 10000,
  });
}

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

  it("reports file count batch limit as files", () => {
    const files = Array.from({ length: MAX_BATCH_FILES + 1 }, (_, i) => `missing-${i}.html`);
    expect(() => scanFilesReport(files, { format: "json", toolVersion: "test" })).toThrow(
      BatchLimitError,
    );
    try {
      scanFilesReport(files, { format: "json", toolVersion: "test" });
    } catch (error) {
      expect(error).toBeInstanceOf(BatchLimitError);
      expect((error as BatchLimitError).kind).toBe("files");
      expect((error as BatchLimitError).actual).toBe(MAX_BATCH_FILES + 1);
      expect((error as Error).message).not.toMatch(/nodes/i);
    }
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
      expect(() => scanFilesReport([file], { format: "json", toolVersion: "test" })).toThrow(
        BatchLimitError,
      );
      try {
        scanFilesReport([file], { format: "json", toolVersion: "test" });
      } catch (error) {
        expect(error).toBeInstanceOf(BatchLimitError);
        expect((error as BatchLimitError).kind).toBe("findings");
        expect((error as BatchLimitError).actual).toBe(MAX_BATCH_FINDINGS + 1);
        expect((error as Error).message).not.toMatch(/nodes/i);
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }, 20_000);
});

describe("CLI directory scanning", () => {
  it("scans a directory recursively and outputs JSON", () => {
    const dir = resolve(here, "../../../examples");
    const output = runCli(["scan", dir, "--format", "json", "--ignore-config"]);
    const report = JSON.parse(output) as FairUxBatchReport;
    expect(report.summary.total).toBeGreaterThan(0);
    const ids = report.reports.flatMap((r) => r.findings).map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(report.inputs.map((input) => input.file)).toEqual(
      report.reports.map((subReport) => subReport.input.file),
    );
  });

  it("renders directory batch Markdown through the shared reporter", () => {
    const dir = resolve(here, "../../../examples");
    const output = runCli(["scan", dir, "--format", "markdown", "--ignore-config"]);
    expect(output).toContain("FairUX does not provide legal judgments");
    expect(output).toContain("# FairUX Batch Report");
  });

  it("renders directory batch SARIF through the shared reporter", () => {
    const dir = resolve(here, "../../../examples");
    const output = runCli(["scan", dir, "--format", "sarif", "--ignore-config"]);
    const sarif = JSON.parse(output);
    expect(sarif.version).toBe("2.1.0");
    expect(sarif.runs[0].invocations[0].executionSuccessful).toBe(true);
    expect(sarif.runs[0].results[0].fingerprints.fairuxV1).toBeDefined();
  });

  it("reports directory batch file limits without node wording", () => {
    const tmp = mkdtempSync(join(tmpdir(), "fairux-dir-limit-"));
    try {
      for (let i = 0; i <= MAX_BATCH_FILES; i++) {
        writeFileSync(join(tmp, `${String(i).padStart(3, "0")}.html`), "<p>Hello</p>", "utf8");
      }
      const res = runCliResult(["scan", tmp, "--format", "json", "--ignore-config"]);
      expect(res.status).toBe(1);
      expect(res.stderr).toContain("batch exceeds files limit");
      expect(res.stderr).toContain(`${MAX_BATCH_FILES + 1} files`);
      expect(res.stderr).not.toMatch(/nodes/i);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("CLI stdin scanning", () => {
  it("scans HTML from stdin with '-' path", () => {
    const html =
      '<html><body><h1>Privacy Settings</h1><form><input type="checkbox" checked> I agree to receive marketing emails</form></body></html>';
    const output = runCli(["scan", "-", "--format", "json", "--ignore-config"], {
      stdin: html,
    });
    const report = JSON.parse(output) as FairUxReport;
    expect(report.findings.length).toBeGreaterThan(0);
    expect(report.findings.some((f) => f.ruleId === "consent/checked-checkbox")).toBe(true);
  });
});

describe("CLI --fail-on", () => {
  it("exits with code 1 when high findings meet --fail-on high", () => {
    const dir = resolve(here, "../../../examples");
    expect(() => {
      execFileSync(
        "node",
        [cliBin, "scan", dir, "--format", "json", "--fail-on", "high", "--ignore-config"],
        {
          encoding: "utf8",
          timeout: 10000,
          stdio: ["pipe", "pipe", "pipe"],
        },
      );
    }).toThrow();
  });

  it("exits with code 0 when --fail-on info and no info findings", () => {
    const tmp = mkdtempSync(join(tmpdir(), "fairux-test-"));
    writeFileSync(join(tmp, "empty.html"), "<p>hello</p>");
    const output = runCli([
      "scan",
      tmp,
      "--format",
      "json",
      "--fail-on",
      "info",
      "--ignore-config",
    ]);
    const report = JSON.parse(output) as FairUxReport;
    expect(report.findings.length).toBe(0);
  });
});

describe("CLI glob scanning", () => {
  it("scans files matching a glob pattern", () => {
    const examplesDir = resolve(here, "../../../examples");
    const pattern = join(examplesDir, "*.html");
    const output = runCli(["scan", pattern, "--format", "json", "--ignore-config"]);
    const report = JSON.parse(output) as FairUxBatchReport;
    expect(report.reports.length).toBeGreaterThan(0);
    expect(report.summary.total).toBeGreaterThan(0);
  });

  it("renders glob batch Markdown and SARIF through the shared reporter", () => {
    const examplesDir = resolve(here, "../../../examples");
    const pattern = join(examplesDir, "*.html");
    const markdown = runCli(["scan", pattern, "--format", "markdown", "--ignore-config"]);
    expect(markdown).toContain("FairUX does not provide legal judgments");

    const sarif = JSON.parse(runCli(["scan", pattern, "--format", "sarif", "--ignore-config"]));
    expect(sarif.version).toBe("2.1.0");
    expect(sarif.runs[0].results[0].fingerprints.fairuxV1).toBeDefined();
  });

  it("scans a relative glob with config auto-discovery enabled", () => {
    const tmp = mkdtempSync(join(tmpdir(), "fairux-glob-config-"));
    try {
      const pages = join(tmp, "pages");
      mkdirSync(pages);
      writeFileSync(join(tmp, "package.json"), '{"name":"fixture"}', "utf8");
      writeFileSync(
        join(tmp, "fairux.config.json"),
        JSON.stringify({ rules: { "consent/checked-checkbox": { severity: "low" } } }),
        "utf8",
      );
      writeFileSync(
        join(pages, "consent.html"),
        '<html><body><label><input type="checkbox" checked> Email me offers</label></body></html>',
        "utf8",
      );
      writeFileSync(join(pages, "clean.html"), "<p>Hello</p>", "utf8");

      const output = runCli(["scan", "pages/**/*.html", "--format", "json"], { cwd: tmp });
      const report = JSON.parse(output) as FairUxBatchReport;
      const finding = report.reports
        .flatMap((r) => r.findings)
        .find((f) => f.ruleId === "consent/checked-checkbox");
      expect(finding?.severity).toBe("low");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("scans an absolute glob deterministically with config auto-discovery enabled", () => {
    const tmp = mkdtempSync(join(tmpdir(), "fairux-glob-absolute-"));
    try {
      const pages = join(tmp, "pages");
      mkdirSync(pages);
      writeFileSync(join(pages, "fairux.config.json"), "{}", "utf8");
      writeFileSync(join(pages, "b.html"), "<button>Buy now</button>", "utf8");
      writeFileSync(join(pages, "a.html"), "<button>Buy now</button>", "utf8");

      const output = runCli(["scan", join(pages, "*.html"), "--format", "json"], { cwd: tmp });
      const report = JSON.parse(output) as FairUxBatchReport;
      expect(report.inputs.map((input) => input.file?.split("/").pop())).toEqual([
        "a.html",
        "b.html",
      ]);
      expect(report.inputs.map((input) => input.file)).toEqual(
        report.reports.map((subReport) => subReport.input.file),
      );
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("uses portable report paths for direct files and single-match globs", () => {
    const tmp = mkdtempSync(join(tmpdir(), "fairux-single-paths-"));
    try {
      const page = join(tmp, "page.html");
      writeFileSync(page, "<button>Buy now</button>", "utf8");

      const direct = JSON.parse(
        runCli(["scan", page, "--format", "json", "--ignore-config"]),
      ) as FairUxReport;
      expect(direct.input.file).toBe(relative(process.cwd(), page));
      expect(isAbsolute(direct.input.file ?? "")).toBe(false);

      const glob = JSON.parse(
        runCli(["scan", join(tmp, "*.html"), "--format", "json", "--ignore-config"]),
      ) as FairUxReport;
      expect(glob.kind).toBe("single");
      expect(glob.input.file).toContain("page.html");
      expect(isAbsolute(glob.input.file ?? "")).toBe(false);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("treats existing paths with glob magic as literal targets", () => {
    const tmp = mkdtempSync(join(tmpdir(), "fairux-literal-glob-"));
    try {
      writeFileSync(join(tmp, "fairux.config.json"), "{}", "utf8");
      const html = join(tmp, "page[1].html");
      const tsx = join(tmp, "pricing{legacy}.tsx");
      writeFileSync(html, "<button>Buy now</button>", "utf8");
      writeFileSync(tsx, `export const Pricing = () => <button>Buy now</button>;`, "utf8");
      writeFileSync(join(tmp, "page1.html"), "<p>Different</p>", "utf8");

      const htmlReport = JSON.parse(
        runCli(["scan", "page[1].html", "--format", "json"], { cwd: tmp }),
      ) as FairUxReport;
      expect(htmlReport.kind).toBe("single");
      expect(htmlReport.input.file).toBe("page[1].html");

      const tsxReport = JSON.parse(
        runCli(["scan", "pricing{legacy}.tsx", "--format", "json"], { cwd: tmp }),
      ) as FairUxReport;
      expect(tsxReport.kind).toBe("single");
      expect(tsxReport.input.file).toBe("pricing{legacy}.tsx");
      expect(tsxReport.input.runtime).toBe("ast");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("fails closed on malformed config discovered from a glob base", () => {
    const tmp = mkdtempSync(join(tmpdir(), "fairux-glob-bad-config-"));
    try {
      const pages = join(tmp, "pages");
      mkdirSync(pages);
      writeFileSync(join(pages, "fairux.config.json"), "{ invalid json", "utf8");
      writeFileSync(join(pages, "page.html"), "<button>Buy now</button>", "utf8");

      const res = runCliResult(["scan", "pages/**/*.html", "--format", "json"], { cwd: tmp });
      expect(res.status).toBe(1);
      expect(res.stderr).toContain("config error");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("reports no scannable files for a no-match glob instead of statting the literal pattern", () => {
    const tmp = mkdtempSync(join(tmpdir(), "fairux-glob-no-match-"));
    try {
      mkdirSync(join(tmp, "pages"));
      const res = runCliResult(["scan", "pages/**/*.html", "--format", "json"], { cwd: tmp });
      expect(res.status).toBe(1);
      expect(res.stderr).toContain("no scannable files found");
      expect(res.stderr).not.toContain("ENOENT");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("CLI Figma scanning", () => {
  it("scans a .figjson file", () => {
    const tmp = mkdtempSync(join(tmpdir(), "fairux-figma-"));
    const figmaJson = JSON.stringify({
      document: {
        id: "0:0",
        name: "Page",
        type: "CANVAS",
        children: [
          {
            id: "1:1",
            name: "Button/Buy",
            type: "COMPONENT",
            componentPropertyDefinitions: {
              Label: { type: "TEXT", defaultValue: "Buy now" },
            },
            children: [{ id: "1:2", name: "Label", type: "TEXT", characters: "Buy now" }],
          },
        ],
      },
      name: "Test Figma",
    });
    const filePath = join(tmp, "test.figjson");
    writeFileSync(filePath, figmaJson);
    const output = runCli(["scan", filePath, "--format", "json", "--ignore-config"]);
    const report = JSON.parse(output) as FairUxReport;
    expect(report.input.runtime).toBe("figma");
  });
});
