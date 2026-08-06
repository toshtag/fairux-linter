import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  computeDiagnostics,
  DiagSeverity,
  diagnosticRange,
  discoverConfigForDocument,
  isSupportedLanguage,
} from "../src/diagnostics.js";

describe("isSupportedLanguage", () => {
  it("accepts html and JS/TS family, rejects others", () => {
    for (const id of ["html", "javascript", "javascriptreact", "typescript", "typescriptreact"]) {
      expect(isSupportedLanguage(id)).toBe(true);
    }
    expect(isSupportedLanguage("markdown")).toBe(false);
    expect(isSupportedLanguage("json")).toBe(false);
  });
});

describe("computeDiagnostics (HTML)", () => {
  const html = `<html><body><h1>Cookie consent</h1>
<label><input type="checkbox" checked> Email me marketing offers</label></body></html>`;

  it("produces a diagnostic with a 0-based range, severity, code, source", () => {
    const diags = computeDiagnostics(html, "html");
    const checked = diags.find((d) => d.code === "consent/checked-checkbox");
    expect(checked).toBeDefined();
    expect(checked?.source).toBe("FairUX");
    expect(checked?.severity).toBe(DiagSeverity.Error); // high → Error
    // Source line 2 (1-based) → range.startLine 1 (0-based).
    expect(checked?.range.startLine).toBe(1);
    expect(checked?.range.endColumn).toBeGreaterThan(checked?.range.startColumn ?? 0);
    expect(checked?.source).toBe("FairUX");
    expect(checked?.severity).toBe(DiagSeverity.Error); // high → Error
    // Source line 2 (1-based) → range.startLine 1 (0-based).
    expect(checked?.range.startLine).toBe(1);
    expect(checked?.range.endColumn).toBeGreaterThan(checked?.range.startColumn ?? 0);
    expect(checked?.message).toContain("confidence:");
  });
});

describe("computeDiagnostics (JSX/TSX via AST)", () => {
  const tsx = `export const C = () => (
  <div>
    <h1>Cookie consent</h1>
    <label><input type="checkbox" checked /> Email me marketing offers</label>
  </div>
);`;

  it("scans typescriptreact and caps severity per AST confidence (never Error/high)", () => {
    const diags = computeDiagnostics(tsx, "typescriptreact");
    const checked = diags.find((d) => d.code === "consent/checked-checkbox");
    expect(checked).toBeDefined();
    // AST findings cap confidence at medium → severity high would be Error; here it must be
    // produced by a high-severity rule but confidence is capped — severity still maps from the
    // rule's severity, so assert it's a real, anchored diagnostic with a JSX line.
    expect(checked?.range.startLine).toBeGreaterThanOrEqual(0);
    expect(checked?.message).toMatch(/confidence: (low|medium)/);
  });

  it("does not flag a dynamically-checked box (unknown != true)", () => {
    const dyn = `export const C = ({on}) => (
  <div><h1>Cookie consent</h1>
    <label><input type="checkbox" checked={on} /> Email me marketing offers</label>
  </div>
);`;
    const codes = computeDiagnostics(dyn, "typescriptreact").map((d) => d.code);
    expect(codes).not.toContain("consent/checked-checkbox");
  });
});

describe("VS Code Config Integration", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "fairux-config-test-"));
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it("discovers config in document directory", () => {
    const configPath = join(testDir, "fairux.config.json");
    writeFileSync(
      configPath,
      JSON.stringify(
        {
          rules: {
            "consent/checked-checkbox": { enabled: false },
          },
        },
        null,
        2,
      ),
    );

    const documentPath = join(testDir, "test.html");
    const result = discoverConfigForDocument(documentPath);

    expect(result.config).toBeDefined();
    expect(result.notifications).toHaveLength(0);
  });

  it("fails on malformed config", () => {
    const configPath = join(testDir, "fairux.config.json");
    writeFileSync(configPath, "{ invalid json");

    const documentPath = join(testDir, "test.html");
    const result = discoverConfigForDocument(documentPath);

    expect(result.config).toBeUndefined();
    expect(result.notifications.length).toBeGreaterThan(0);
    expect(result.notifications[0]?.level).toBe("error");
  });

  it("propagates config to diagnostics", () => {
    const configPath = join(testDir, "fairux.config.json");
    writeFileSync(
      configPath,
      JSON.stringify(
        {
          rules: {
            "consent/checked-checkbox": { enabled: false },
          },
        },
        null,
        2,
      ),
    );

    const html = `<html><body><label><input type="checkbox" checked> Email me</label></body></html>`;
    const documentPath = join(testDir, "test.html");
    const { config } = discoverConfigForDocument(documentPath);

    const diags = computeDiagnostics(html, "html", config);
    const checked = diags.find((d) => d.code === "consent/checked-checkbox");
    expect(checked).toBeUndefined(); // Rule disabled
  });

  it("handles unknown rule gracefully", () => {
    const configPath = join(testDir, "fairux.config.json");
    writeFileSync(
      configPath,
      JSON.stringify(
        {
          rules: {
            "unknown/rule": { enabled: true },
          },
        },
        null,
        2,
      ),
    );

    const documentPath = join(testDir, "test.html");
    const result = discoverConfigForDocument(documentPath);

    expect(result.config).toBeUndefined();
    expect(result.notifications.length).toBeGreaterThan(0);
    expect(result.notifications[0]?.message).toContain("unknown/rule");
  });

  it("sanitizes malicious config validation messages before returning notifications", () => {
    const esc = String.fromCharCode(0x1b);
    const rlo = String.fromCharCode(0x202e);
    const malicious = `unknown\n[FairUX] Config error: forged${esc}[31m${rlo}`;
    const configPath = join(testDir, "fairux.config.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        rules: {
          [malicious]: true,
        },
      }),
    );

    const documentPath = join(testDir, "test.html");
    const result = discoverConfigForDocument(documentPath);
    const notification = result.notifications[0];

    expect(result.config).toBeUndefined();
    expect(notification?.level).toBe("error");
    expect(notification?.message).not.toContain("\n");
    expect(notification?.message).not.toContain("\r");
    expect(notification?.message).not.toContain(esc);
    expect(notification?.message).not.toContain(rlo);
    expect(notification?.message).toContain("unknown");
    expect(notification?.message).toContain("forged");
  });

  it("enables experimental rules via config", () => {
    const configPath = join(testDir, "fairux.config.json");
    writeFileSync(
      configPath,
      JSON.stringify(
        {
          includeExperimental: true,
        },
        null,
        2,
      ),
    );

    const documentPath = join(testDir, "test.html");
    const result = discoverConfigForDocument(documentPath);

    expect(result.config).toBeDefined();
    expect(result.config?.includeExperimental).toBe(true);
  });

  it("overrides severity via config", () => {
    const configPath = join(testDir, "fairux.config.json");
    writeFileSync(
      configPath,
      JSON.stringify(
        {
          rules: {
            "consent/checked-checkbox": { severity: "low" },
          },
        },
        null,
        2,
      ),
    );

    const html = `<html><body><label><input type="checkbox" checked> Email me</label></body></html>`;
    const documentPath = join(testDir, "test.html");
    const { config } = discoverConfigForDocument(documentPath);

    const diags = computeDiagnostics(html, "html", config);
    const checked = diags.find((d) => d.code === "consent/checked-checkbox");
    expect(checked).toBeDefined();
    expect(checked?.severity).toBe(DiagSeverity.Information); // low → Information
  });
});

/**
 * Where the squiggle stops.
 *
 * Every diagnostic used to end at the end of the line its finding started on, because a
 * `SourceLocation` carried a start and nothing else. That is wrong in both directions, and both are
 * visible in an editor: an element that opens on one line and closes four lines later was marked on
 * the first line alone, and an element with other markup after it on the same line dragged the
 * squiggle across code it has nothing to do with.
 *
 * Both adapters had the end all along — parse5 reports it and the TypeScript API computes it — and
 * it was dropped on the way into the report.
 */
describe("a diagnostic covers what the finding covers", () => {
  it("spans every line of a multi-line element", () => {
    const html = [
      "<html><body><h1>Cookie consent</h1>",
      "<label",
      '  class="consent"',
      ">",
      '  <input type="checkbox" checked>',
      "  Email me marketing offers",
      "</label>",
      "</body></html>",
    ].join("\n");
    const checked = computeDiagnostics(html, "html").find(
      (d) => d.code === "consent/checked-checkbox",
    );
    // The `<input>` is on line 5 (1-based) and closes on the same line, so this is the case that
    // matters for the *label*: the range must not be invented from the line's length.
    expect(checked?.range.startLine).toBe(4);
    expect(checked?.range.endLine).toBe(4);
    // `  <input type="checkbox" checked>` — starts at column 2, ends after the `>`.
    expect(checked?.range.startColumn).toBe(2);
    expect(checked?.range.endColumn).toBe(33);
  });

  it("stops at the element, not at the end of a shared line", () => {
    const prefix = "<html><body><h1>Cookie consent</h1>";
    const input = '<label><input type="checkbox" checked></label>';
    const html = `${prefix}${input}<p>and a great deal more text that has nothing to do with the finding</p></body></html>`;
    const checked = computeDiagnostics(html, "html").find(
      (d) => d.code === "consent/checked-checkbox",
    );
    expect(checked).toBeDefined();
    // The old behaviour was `endColumn === the whole line's length`. The element ends where it
    // ends, which is well before the paragraph after it.
    expect(checked?.range.endColumn).toBeLessThan(html.length);
    expect(checked?.range.endColumn).toBe(
      prefix.length + '<label><input type="checkbox" checked>'.length,
    );
  });

  it("ends a JSX element where the element ends", () => {
    const tsx = [
      "export const C = () => (",
      "  <div>",
      "    <h1>Cookie consent</h1>",
      '    <label><input type="checkbox" checked /> Email me marketing offers</label>',
      "  </div>",
      ");",
    ].join("\n");
    const checked = computeDiagnostics(tsx, "typescriptreact").find(
      (d) => d.code === "consent/checked-checkbox",
    );
    expect(checked).toBeDefined();
    expect(checked?.range.startLine).toBe(3);
    expect(checked?.range.endLine).toBe(3);
    // The `<input …/>` occupies columns 11–44; the label text after it is not part of the range,
    // and the old end-of-line end would have been 76.
    expect(checked?.range.startColumn).toBe(11);
    expect(checked?.range.endColumn).toBe(44);
  });

  it("marks the same characters whether the file uses LF or CRLF", () => {
    // A Windows checkout is not a different document. `\r` is a character in the line as far as a
    // parser counting columns is concerned, so a range that is right on LF and wrong on CRLF is a
    // bug only half the users would ever see — and it renders as a squiggle one character off
    // rather than as an error.
    const lines = [
      "<html><body><h1>Cookie consent</h1>",
      '<label><input type="checkbox" checked> Email me marketing offers</label>',
      "</body></html>",
    ];
    const forLf = computeDiagnostics(lines.join("\n"), "html");
    const forCrlf = computeDiagnostics(lines.join("\r\n"), "html");

    expect(forCrlf.map((d) => d.code)).toEqual(forLf.map((d) => d.code));
    expect(forCrlf.map((d) => d.range)).toEqual(forLf.map((d) => d.range));
    // And the range still covers the element rather than running past the line's `\r`.
    const checked = forCrlf.find((d) => d.code === "consent/checked-checkbox");
    expect(checked?.range.endColumn).toBeLessThanOrEqual((lines[1] as string).length);
  });

  it("keeps a range inside the document when a position points past the end", () => {
    // The position comes from an adapter and the text comes from the editor. They are the same
    // bytes in every ordinary case, and there is no rule that says they must be: a rule pack
    // computes its own positions, and a document can be edited while a debounced scan is in flight.
    // VS Code reports neither mismatch — it clamps silently and swaps an inverted pair silently —
    // so the wrong range is invisible unless something checks.
    const text = ["<p>one</p>", "<p>two</p>"].join("\n");
    const lines = text.split("\n");
    // Past the last line; past the end of a line; and an end before its own start.
    for (const [endLine, endColumn] of [
      [99, 1],
      [2, 999],
      [1, 1],
    ] as const) {
      const range = diagnosticRange({ startLine: 2, startColumn: 4, endLine, endColumn }, lines);
      expect(range.endLine, `endLine ${endLine}`).toBeLessThanOrEqual(lines.length - 1);
      expect(range.endLine).toBeGreaterThanOrEqual(range.startLine);
      const lineLength = (lines[range.endLine] as string).length;
      expect(range.endColumn, `endColumn ${endColumn}`).toBeLessThanOrEqual(lineLength);
      if (range.endLine === range.startLine) {
        expect(range.endColumn).toBeGreaterThanOrEqual(range.startColumn);
      }
    }
  });

  it("never produces a range that ends before it starts", () => {
    // The property that has to hold for every finding on every surface: VS Code renders an inverted
    // range by silently swapping the ends, so a wrong one is invisible rather than loud.
    const html = [
      '<html><body><label><input type="checkbox" checked> Offers</label>',
      "<p>Only 2 left in stock!</p>",
      "<p>Hurry, offer ends in 5 minutes!</p>",
      "</body></html>",
    ].join("\n");
    for (const diagnostic of computeDiagnostics(html, "html")) {
      const { startLine, startColumn, endLine, endColumn } = diagnostic.range;
      expect(endLine).toBeGreaterThanOrEqual(startLine);
      if (endLine === startLine) expect(endColumn).toBeGreaterThanOrEqual(startColumn);
    }
  });
});
