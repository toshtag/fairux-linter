import { readFileSync } from "node:fs";
import { type FairuxConfig, scan } from "@fairux/core";
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

/** Read a static HTML file, scan it with all rules, and render the chosen format. */
export function scanFile(filePath: string, options: ScanFileOptions): string {
  const html = readFileSync(filePath, "utf8");
  const cfg = options.config ?? {};
  // Precedence: explicit CLI flag > config > default(false). The CLI passes `undefined` when
  // the user did NOT pass `--include-experimental`, so config wins in that case.
  const includeExperimental = options.includeExperimental ?? cfg.includeExperimental ?? false;
  const report = scan(parseHtml(html, { file: filePath }), allRules, {
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
