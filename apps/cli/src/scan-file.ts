import { readFileSync } from "node:fs";
import { scan } from "@fairux/core";
import { parseHtml } from "@fairux/html";
import { toJson, toMarkdown } from "@fairux/report";
import { allRules, dictionary } from "@fairux/rules";

export type OutputFormat = "json" | "markdown";

export interface ScanFileOptions {
  format: OutputFormat;
  includeExperimental?: boolean;
  toolVersion?: string;
  /** Injectable clock for deterministic output in tests. */
  now?: () => Date;
}

/** Read a static HTML file, scan it with all rules, and render the chosen format. */
export function scanFile(filePath: string, options: ScanFileOptions): string {
  const html = readFileSync(filePath, "utf8");
  const report = scan(parseHtml(html, { file: filePath }), allRules, {
    dictionary,
    includeExperimental: options.includeExperimental,
    toolVersion: options.toolVersion,
    now: options.now,
  });
  return options.format === "json" ? toJson(report) : toMarkdown(report);
}
