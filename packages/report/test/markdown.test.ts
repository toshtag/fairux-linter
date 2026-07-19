import type { FairUxBatchReport, FairUxReport } from "@fairux/core";
import { describe, expect, it } from "vitest";
import { DISCLAIMER, toBatchMarkdown, toMarkdown } from "../src/index.js";
import { emptyReport, externalCategoryReport, sampleReport } from "./_fixture.js";

describe("toMarkdown", () => {
  const md = toMarkdown(sampleReport);

  it("includes the legal disclaimer", () => {
    expect(md).toContain(DISCLAIMER);
  });

  it("shows severity, confidence, recommendation and evidence", () => {
    expect(md).toContain("**Severity:** high  **Confidence:** medium");
    expect(md).toContain("**Recommendation:**");
    expect(md).toContain("`#start-trial`");
    expect(md).toContain("(checkout.html:12)");
  });

  it("groups findings high → medium → low", () => {
    expect(md.indexOf("## High")).toBeLessThan(md.indexOf("## Medium"));
    expect(md.indexOf("## Medium")).toBeLessThan(md.indexOf("## Low"));
  });

  it("renders a clean message when there are no findings", () => {
    const out = toMarkdown(emptyReport);
    expect(out).toContain(DISCLAIMER);
    expect(out).toContain("No findings.");
  });

  it("renders rule-pack provenance when present", () => {
    const out = toMarkdown({
      ...emptyReport,
      rulePacks: [{ id: "@fairux/builtin", version: "0.1.0" }],
    });
    expect(out).toContain("**Rule packs:**");
    expect(out).toContain("`@fairux/builtin` 0.1.0");
  });

  it("preserves external category ids", () => {
    expect(toMarkdown(externalCategoryReport)).toContain(
      "**Category:** `purchase-guard/return-policy`",
    );
  });

  it("matches the Markdown snapshot", () => {
    expect(md).toMatchSnapshot();
  });
});

describe("toBatchMarkdown", () => {
  const esc = String.fromCharCode(0x1b);
  const rlo = String.fromCharCode(0x202e);

  it("includes disclaimer and sanitizes per-file headings", () => {
    const batch: FairUxBatchReport = {
      kind: "batch",
      schemaVersion: "0.1",
      toolVersion: "1.0.0",
      generatedAt: "2026-01-01T00:00:00.000Z",
      inputs: [{ file: `evil\n# heading ${esc}[31m ${rlo}\`break\`.html`, runtime: "html" }],
      summary: {
        total: 1,
        bySeverity: { info: 0, low: 0, medium: 0, high: 1 },
      },
      reports: [
        {
          input: { file: `evil\n# heading ${esc}[31m ${rlo}\`break\`.html`, runtime: "html" },
          summary: { total: 1, bySeverity: { info: 0, low: 0, medium: 0, high: 1 } },
          findings: [
            {
              id: "0:test/injection#0",
              fingerprint: "0000000000000000",
              batchOccurrenceId: "aaaaaaaaaaaaaaaa",
              ruleId: "test/`injection`",
              category: "consent",
              severity: "high",
              confidence: "medium",
              title: "### Injected Heading",
              description: `${esc}[31mRed text${esc}[0m`,
              evidence: [{ locator: { type: "css", value: "#evil`code`" }, text: "bad" }],
              whyItMatters: "Why with [link](http://evil.com)",
              recommendation: "Fix `code`",
            },
          ],
        },
      ],
    };

    const out = toBatchMarkdown(batch);
    expect(out).toContain(DISCLAIMER);
    expect(out).not.toContain(esc);
    expect(out).not.toContain(rlo);
    expect(out).not.toMatch(/evil\n/);
    expect(out).not.toContain("## File 1: evil");
    expect(out).not.toContain("### Injected Heading");
    expect(out).not.toContain("`break`");
    expect(out).toContain("## File 1: `");
  });

  it("renders an empty batch cleanly", () => {
    const batch: FairUxBatchReport = {
      kind: "batch",
      schemaVersion: "0.1",
      toolVersion: "1.0.0",
      generatedAt: "2026-01-01T00:00:00.000Z",
      inputs: [],
      summary: { total: 0, bySeverity: { info: 0, low: 0, medium: 0, high: 0 } },
      reports: [],
    };
    const out = toBatchMarkdown(batch);
    expect(out).toContain(DISCLAIMER);
    expect(out).toContain("No findings.");
  });

  it("renders batch rule-pack provenance when present", () => {
    const batch: FairUxBatchReport = {
      kind: "batch",
      schemaVersion: "0.1",
      toolVersion: "1.0.0",
      generatedAt: "2026-01-01T00:00:00.000Z",
      inputs: [],
      rulePacks: [{ id: "@fairux/builtin", version: "0.1.0" }],
      summary: { total: 0, bySeverity: { info: 0, low: 0, medium: 0, high: 0 } },
      reports: [],
    };
    const out = toBatchMarkdown(batch);
    expect(out).toContain("`@fairux/builtin` 0.1.0");
  });
});

describe("toMarkdown injection sanitization (P10-T10)", () => {
  const esc = String.fromCharCode(0x1b); // ANSI ESC
  const rlo = String.fromCharCode(0x202e); // RIGHT-TO-LEFT OVERRIDE

  const maliciousReport: FairUxReport = {
    kind: "single",
    schemaVersion: "0.1",
    toolVersion: "1.0.0",
    generatedAt: "2026-01-01T00:00:00.000Z",
    input: { file: `evil\n${esc}[31m.html`, runtime: "html" },
    summary: { total: 1, bySeverity: { info: 0, low: 0, medium: 0, high: 1 } },
    findings: [
      {
        id: "test/injection#0",
        fingerprint: "0000000000000000",
        ruleId: "test/`injection`",
        category: "consent",
        severity: "high",
        confidence: "medium",
        title: "### Injected Heading\n**Evil:** yes",
        description: `${esc}[31mRed text${esc}[0m`,
        evidence: [
          {
            locator: { type: "css", value: "#evil`code`" },
            text: `]]>--><script>alert(1)</script>`,
            source: { file: `evil\n${rlo}gpj.html`, startLine: 1 },
          },
        ],
        whyItMatters: "Why with *emphasis* and [link](http://evil.com)",
        recommendation: "Fix with `code` and | table |",
      },
    ],
  };

  it("strips ANSI escape sequences from all fields", () => {
    const out = toMarkdown(maliciousReport);
    expect(out).not.toContain(esc);
  });

  it("strips newlines from file paths", () => {
    const out = toMarkdown(maliciousReport);
    expect(out).not.toMatch(/evil\n/);
  });

  it("escapes backticks in inline code contexts (rule IDs, locators)", () => {
    const out = toMarkdown(maliciousReport);
    expect(out).not.toContain("`injection`");
    expect(out).not.toContain("`code`");
  });

  it("escapes Markdown structural characters in text fields", () => {
    const out = toMarkdown(maliciousReport);
    expect(out).not.toContain("### Injected Heading");
    expect(out).not.toContain("[link](http://evil.com)");
  });

  it("strips Unicode bidi controls", () => {
    const out = toMarkdown(maliciousReport);
    expect(out).not.toContain(rlo);
  });
});
