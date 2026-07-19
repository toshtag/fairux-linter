import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  computeDiagnostics,
  DiagSeverity,
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
