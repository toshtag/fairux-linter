import { readFileSync } from "node:fs";
import { extname } from "node:path";
import { parseSource } from "@fairux/ast";
import { type FairuxConfig, scan, type UiDocument } from "@fairux/core";
import { parseHtml } from "@fairux/html";
import { toJson, toMarkdown, toSarif } from "@fairux/report";
import { allRules, dictionary } from "@fairux/rules";

export type OutputFormat = "json" | "markdown" | "sarif";

export interface ScanFileOptions {
  format: OutputFormat;
  /** Explicit CLI flag wins over `config.includeExperimental` when set. */
  includeExperimental?: boolean;
  toolVersion?: string;
  /** Injectable clock for deterministic output in tests. */
  now?: () => Date;
  /** Already-loaded `fairux.config.*` content (the CLI loads it; this layer just consumes). */
  config?: FairuxConfig;
  /**
   * Path to record in the report (report metadata, evidence `source.file`, AST locators, SARIF
   * `artifactLocation.uri`). The file is READ from `filePath` (resolved/absolute), but the report
   * should carry the user's requested path — typically relative — so output is stable across
   * checkouts/runners and fingerprints don't shift with the absolute prefix. Defaults to `filePath`.
   */
  reportPath?: string;
}

const AST_EXTENSIONS = new Set([".tsx", ".jsx", ".ts", ".js", ".mts", ".cts", ".mjs", ".cjs"]);

/**
 * Pick the adapter by file extension: JSX/TSX (and plain JS/TS) → the AST adapter; everything
 * else → the static-HTML adapter. The extension is taken from `filePath` (what we actually read);
 * the `file` recorded in the document is `reportPath` (what we display). AST findings are
 * static-only and confidence-capped at medium (see ADR P6-T2); HTML findings keep full locations.
 */
function parseByExtension(filePath: string, reportPath: string, source: string): UiDocument {
  return AST_EXTENSIONS.has(extname(filePath).toLowerCase())
    ? parseSource(source, { file: reportPath })
    : parseHtml(source, { file: reportPath });
}

/** Read a UI source file, scan it with all rules (adapter chosen by extension), and render. */
export function scanFile(filePath: string, options: ScanFileOptions): string {
  const source = readFileSync(filePath, "utf8");
  const reportPath = options.reportPath ?? filePath;
  const cfg = options.config ?? {};
  // Precedence: explicit CLI flag > config > default(false). The CLI passes `undefined` when
  // the user did NOT pass `--include-experimental`, so config wins in that case.
  const includeExperimental = options.includeExperimental ?? cfg.includeExperimental ?? false;
  const report = scan(parseByExtension(filePath, reportPath, source), allRules, {
    dictionary,
    ruleOverrides: cfg.rules,
    includeExperimental,
    toolVersion: options.toolVersion,
    now: options.now,
  });
  switch (options.format) {
    case "json":
      return toJson(report);
    case "sarif":
      // Pass the rule registry so tool.driver.rules[] carries title/category/helpUri/tags
      // (not just id-only). Per ADR P4-T1.
      return toSarif(report, { rules: allRules.map((r) => r.meta) });
    default:
      return toMarkdown(report);
  }
}
