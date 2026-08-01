import type { FairUxBatchReport, FairUxReport } from "@fairux/core";
import { Window } from "happy-dom";
import { describe, expect, it } from "vitest";
import { DISCLAIMER, toBatchHtml, toHtml } from "../src/index.js";
import { sampleReport } from "./_fixture.js";

/**
 * Everything in a finding is untrusted text from the scanned page — evidence snippets are literally
 * markup FairUX found. A report that interpolated any of it unescaped would execute the scanned
 * site's script the moment a reviewer opened it, so these cases carry real breakout payloads rather
 * than a `<script>` string that happens to be caught.
 */
const HOSTILE = [
  "<script>alert(1)</script>",
  '"><script>alert(2)</script>',
  "'><img src=x onerror=alert(3)>",
  "</title></style></textarea><script>alert(4)</script>",
  "javascript:alert(5)",
  "<svg/onload=alert(6)>",
  '" onmouseover="alert(7)',
  "&lt;already escaped&gt;",
];

/**
 * Parse the report and report what a browser would actually see.
 *
 * Substring assertions are the wrong instrument here and were the first thing this file got wrong:
 * `&quot; onmouseover=&quot;x` contains the substring ` onmouseover=` while being completely inert.
 * Only a parser can distinguish "an attribute exists" from "those characters appear as text", and
 * an attribute existing is the thing that matters.
 */
function inspect(output: string) {
  const window = new Window();
  window.document.write(output);
  const elements = [...window.document.querySelectorAll("*")];
  return {
    scripts: window.document.querySelectorAll("script").length,
    eventHandlers: elements.flatMap((element) =>
      [...element.attributes]
        .map((attribute) => attribute.name)
        .filter((name) => name.toLowerCase().startsWith("on")),
    ),
    remoteRefs: elements.flatMap((element) =>
      [...element.attributes]
        .filter((attribute) => ["src", "href", "srcset", "action"].includes(attribute.name))
        .map((attribute) => attribute.value),
    ),
    text: window.document.body?.textContent ?? "",
  };
}

function reportWith(text: string): FairUxReport {
  return {
    ...sampleReport,
    input: { ...sampleReport.input, file: text },
    findings: [
      {
        ...sampleReport.findings[0],
        title: text,
        description: text,
        whyItMatters: text,
        recommendation: text,
        ruleId: text,
        evidence: [{ snippet: text, source: { file: text, startLine: 1 } }],
      },
    ],
  } as unknown as FairUxReport;
}

describe("toHtml is self-contained", () => {
  const output = toHtml(sampleReport);

  it("carries no script and no event handler at all", () => {
    // Not "no inline handler on the elements we wrote" — none anywhere, checked after parsing.
    const parsed = inspect(output);
    expect(parsed.scripts).toBe(0);
    expect(parsed.eventHandlers).toEqual([]);
  });

  it("loads nothing from the network", () => {
    // It has to render as an artifact, an email attachment, or in an air-gapped review — and it
    // must not be able to report back on what was scanned.
    expect(inspect(output).remoteRefs).toEqual([]);
    expect(output).not.toMatch(/https?:\/\//i);
    expect(output).not.toMatch(/@import/i);
    expect(output).not.toMatch(/url\s*\(/i);
  });

  it("is a complete document with an explicit charset", () => {
    expect(output.startsWith("<!doctype html>")).toBe(true);
    expect(output).toContain('<meta charset="utf-8">');
    expect(output.trimEnd().endsWith("</html>")).toBe(true);
  });

  it("carries the disclaimer as prominently as every other format", () => {
    expect(output).toContain(DISCLAIMER);
  });
});

describe("toHtml escapes untrusted finding text", () => {
  for (const payload of HOSTILE) {
    it(`renders ${JSON.stringify(payload.slice(0, 32))} as text`, () => {
      const parsed = inspect(toHtml(reportWith(payload)));
      // Nothing a browser would act on survived.
      expect(parsed.scripts).toBe(0);
      expect(parsed.eventHandlers).toEqual([]);
      expect(parsed.remoteRefs).toEqual([]);
      // And the payload is still *there*, as text. Escaping that dropped the evidence would be a
      // different bug, and a quieter one.
      expect(parsed.text).toContain(payload);
    });
  }

  it("escapes quotes, not only angle brackets", () => {
    // `"` and `'` are what turn an interpolation inside an attribute into a new attribute, and
    // evidence text routinely contains quotes because it is markup.
    const parsed = inspect(toHtml(reportWith(`" onmouseover="x`)));
    expect(parsed.eventHandlers).toEqual([]);
    expect(parsed.text).toContain(`" onmouseover="x`);
  });

  it("does not double-escape into nonsense", () => {
    // `&lt;` in the source page must read back as `&lt;`, not as `<`.
    expect(inspect(toHtml(reportWith("&lt;b&gt;"))).text).toContain("&lt;b&gt;");
  });

  it("escapes the same way inside a batch report", () => {
    const batch = {
      ...sampleReport,
      inputs: [{ file: "<script>alert(1)</script>", runtime: "html" }],
      reports: [reportWith("<script>alert(1)</script>")],
      summary: { total: 1, bySeverity: { info: 0, low: 0, medium: 1, high: 0 } },
    } as unknown as FairUxBatchReport;
    const parsed = inspect(toBatchHtml(batch));
    expect(parsed.scripts).toBe(0);
    expect(parsed.eventHandlers).toEqual([]);
    expect(parsed.text).toContain("<script>alert(1)</script>");
  });
});

describe("toHtml says what an empty report means", () => {
  it("never presents no findings as a clean bill of health", () => {
    // The boundary this whole project keeps: zero findings is not proof of anything.
    const empty = {
      ...sampleReport,
      findings: [],
      summary: { total: 0, bySeverity: { info: 0, low: 0, medium: 0, high: 0 } },
    } as unknown as FairUxReport;
    const output = toHtml(empty);
    expect(output).toContain("not a statement that the page is fair or compliant");
    expect(output).toContain(DISCLAIMER);
  });
});

describe("toHtml reports what a reader needs to act", () => {
  const output = toHtml(sampleReport);

  it("names the rule, the severity, why it matters, and what to do", () => {
    const finding = sampleReport.findings[0];
    if (!finding) throw new Error("expected a fixture finding");
    expect(output).toContain(finding.ruleId);
    expect(output).toContain(finding.severity);
    expect(output).toContain("Why it matters");
    expect(output).toContain("Recommendation");
  });

  it("records the rule packs that produced it", () => {
    const withPacks = toHtml({
      ...sampleReport,
      rulePacks: [{ id: "@fairux/builtin", version: "0.1.0" }],
    } as unknown as FairUxReport);
    expect(withPacks).toContain("@fairux/builtin@0.1.0");
  });
});
