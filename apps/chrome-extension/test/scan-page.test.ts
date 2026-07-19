// @vitest-environment happy-dom
import type { FairUxReport } from "@fairux/core";
import { describe, expect, it } from "vitest";
import { scanCurrentDocument } from "../src/scan-page.js";

const ruleIds = (r: FairUxReport) => r.findings.map((f) => f.ruleId);

describe("scanCurrentDocument (the extension's engine)", () => {
  it("scans the live DOM and returns a FairUxReport with dom runtime", () => {
    document.documentElement.innerHTML = `<body><h1>Cookie consent</h1>
      <label><input type="checkbox" checked> Email me marketing offers</label></body>`;
    const report = scanCurrentDocument(document, "9.9.9");
    expect(report.input.runtime).toBe("dom");
    expect(report.toolVersion).toBe("9.9.9");
    expect(ruleIds(report)).toContain("consent/checked-checkbox");
  });

  it("reflects user-toggled state (DOM property read), unlike static HTML", () => {
    document.documentElement.innerHTML = `<body><h1>Cookie consent</h1>
      <label><input id="m" type="checkbox"> Email me marketing offers</label></body>`;
    (document.getElementById("m") as HTMLInputElement).checked = true; // user clicks it
    const report = scanCurrentDocument(document, "0.0.0");
    expect(ruleIds(report)).toContain("consent/checked-checkbox");
  });

  it("returns an empty report on a clean page", () => {
    document.documentElement.innerHTML = `<body><h1>About us</h1><p>We make widgets.</p></body>`;
    const report = scanCurrentDocument(document, "0.0.0");
    expect(report.summary.total).toBe(0);
    expect(report.findings).toEqual([]);
  });
});
