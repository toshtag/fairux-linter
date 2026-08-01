import type { FairUxBatchReport, FairUxReport } from "@fairux/core";
import { describe, expect, it } from "vitest";
import { DISCLAIMER, toBatchMarkdown, toMarkdown } from "../src/index.js";
import {
  emptyReport,
  emptyReportWithCoverage,
  externalCategoryReport,
  sampleCoverage,
  sampleReport,
  sampleReportWithCoverage,
} from "./_fixture.js";

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

describe("toMarkdown coverage", () => {
  const md = toMarkdown(sampleReportWithCoverage);

  it("names what the scan had and what it lacked", () => {
    expect(md).toContain("## Coverage");
    expect(md).toContain("**Capabilities available:** structure, text, attributes");
    expect(md).toContain("**Capabilities unavailable:** dom-state, computed-style");
  });

  it("counts rules without dividing them", () => {
    expect(md).toContain("**Rules:** 2 ran, 2 skipped, 1 not enabled, of 5 in the rule set");
    // No percentage and no ratio — a number derived from these counts is M4's subject, and it
    // cannot be reported without coverage beside it. The only "score" in the output is the sentence
    // saying this is not one.
    expect(md).not.toMatch(/\d+\s*%/);
    expect(md).not.toMatch(/\d+\s*\/\s*\d+/);
    expect(md).toContain("It is not a score");
  });

  it("separates a rule that could not run from one the config turned off", () => {
    expect(md).toContain("**This input cannot supply what they require:**");
    expect(md).toContain("`journey/cancellation-path` — needs journey");
    expect(md).toContain("**Not enabled by this configuration:**");
    expect(md).toContain("`consent/accept-reject-visual-imbalance`");
    expect(md).toContain("**Scoped to a page context this input does not match:**");
  });

  it("reports a rule that ran without its optional evidence as the weaker pass it is", () => {
    expect(md).toContain("**Ran without optional evidence:**");
    expect(md).toContain("`obstruction/modal-close-visibility` — no computed-style, viewport");
  });

  it("says what the counts do not mean", () => {
    expect(md).toContain("Coverage says which rules ran, not whether they were right");
  });

  it("renders coverage when there are no findings, which is when it matters most", () => {
    const out = toMarkdown(emptyReportWithCoverage);
    expect(out).toContain("No findings.");
    expect(out).toContain("## Coverage");
    expect(out).toContain("`journey/cancellation-path` — needs journey");
    // Coverage comes first: "No findings" read alone is the ambiguity this section exists to remove.
    expect(out.indexOf("## Coverage")).toBeLessThan(out.indexOf("No findings."));
  });

  it("omits the section entirely for a report that carries no coverage", () => {
    expect(toMarkdown(emptyReport)).not.toContain("## Coverage");
  });
});

describe("toBatchMarkdown coverage", () => {
  it("renders coverage per input rather than once for the batch", () => {
    const out = toBatchMarkdown({
      kind: "batch",
      schemaVersion: "0.1",
      toolVersion: "1.0.0",
      generatedAt: "2026-01-01T00:00:00.000Z",
      inputs: [
        { file: "a.html", runtime: "html" },
        { file: "b.figma.json", runtime: "figma" },
      ],
      summary: { total: 0, bySeverity: { info: 0, low: 0, medium: 0, high: 0 } },
      reports: [
        {
          input: { file: "a.html", runtime: "html" },
          summary: { total: 0, bySeverity: { info: 0, low: 0, medium: 0, high: 0 } },
          coverage: sampleCoverage,
          findings: [],
        },
        {
          input: { file: "b.figma.json", runtime: "figma" },
          summary: { total: 0, bySeverity: { info: 0, low: 0, medium: 0, high: 0 } },
          coverage: {
            ...sampleCoverage,
            capabilities: {
              available: ["structure", "text", "attributes"],
              unavailable: ["source-location", "style-hints"],
            },
          },
          findings: [],
        },
      ],
    });

    expect(out.match(/### Coverage/g)).toHaveLength(2);
    expect(out).toContain("**Capabilities unavailable:** source-location, style-hints");
  });
});
