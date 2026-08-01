import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { scanFileReport, scanFilesReport } from "../src/scan-file.js";

const html = `<main><label><input type="checkbox" checked> Email me offers</label></main>`;

const figma = JSON.stringify({
  name: "Consent Design",
  document: {
    id: "0:0",
    name: "Document",
    type: "DOCUMENT",
    children: [
      {
        id: "1:1",
        name: "Checkbox/Marketing",
        type: "COMPONENT",
        componentProperties: { "Checked#0:1": { type: "BOOLEAN", value: true } },
        children: [{ id: "1:2", name: "Label", type: "TEXT", characters: "Email me offers" }],
      },
    ],
  },
});

function withTempDir<T>(run: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "fairux-coverage-"));
  try {
    return run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("coverage in the CLI's reports", () => {
  it("carries coverage on a single-file report", () => {
    withTempDir((dir) => {
      const file = join(dir, "page.html");
      writeFileSync(file, html, "utf8");
      const report = scanFileReport(file, { format: "json", toolVersion: "test" });

      expect(report.coverage?.capabilities.available).toContain("source-location");
      expect(report.coverage?.capabilities.unavailable).toContain("network");
      expect(report.coverage?.summary.total).toBeGreaterThan(0);
      expect(report.coverage?.summary.executed).toBeGreaterThan(0);
      // Every rule in the pack is accounted for, not only the ones that ran.
      expect(report.coverage?.rules).toHaveLength(report.coverage?.summary.total ?? -1);
    });
  });

  it("keeps coverage per input rather than rolling it up across a batch", () => {
    withTempDir((dir) => {
      const page = join(dir, "page.html");
      const design = join(dir, "design.figma.json");
      writeFileSync(page, html, "utf8");
      writeFileSync(design, figma, "utf8");

      const batch = scanFilesReport([page, design], { format: "json", toolVersion: "test" });
      const [htmlReport, figmaReport] = batch.reports;

      // The two inputs could not check the same things, and the report says so per input. One merged
      // block would have to over-claim for the Figma export or under-claim for the HTML page.
      expect(htmlReport?.coverage?.capabilities.available).toContain("source-location");
      expect(figmaReport?.coverage?.capabilities.available).not.toContain("source-location");
      expect(figmaReport?.coverage?.capabilities.unavailable).toContain("style-hints");
    });
  });
});
