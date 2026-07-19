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
}

const AST_EXTENSIONS = new Set([".tsx", ".jsx", ".ts", ".js", ".mts", ".cts", ".mjs", ".cjs"]);

/**
 * Pick the adapter by file extension: JSX/TSX (and plain JS/TS) → the AST adapter; everything
 * else → the static-HTML adapter. AST findings are static-only and confidence-capped at medium
 * (see ADR P6-T2); HTML findings keep full source locations.
 */
function parseByExtension(filePath: string, source: string): UiDocument {
  return AST_EXTENSIONS.has(extname(filePath).toLowerCase())
    ? parseSource(source, { file: filePath })
    : parseHtml(source, { file: filePath });
}

/** Read a UI source file, scan it with all rules (adapter chosen by extension), and render. */
export function scanFile(filePath: string, options: ScanFileOptions): string {
  const source = readFileSync(filePath, "utf8");
  const cfg = options.config ?? {};
  // Precedence: explicit CLI flag > config > default(false). The CLI passes `undefined` when
  // the user did NOT pass `--include-experimental`, so config wins in that case.
  const includeExperimental = options.includeExperimental ?? cfg.includeExperimental ?? false;
  const report = scan(parseByExtension(filePath, source), allRules, {
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
