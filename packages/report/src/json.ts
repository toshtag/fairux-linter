import type { FairUxReport } from "@fairux/core";

export interface JsonReportOptions {
  /** Pretty-print with 2-space indent (default true). */
  pretty?: boolean;
}

/**
 * Serialize a report as JSON. This output is a PUBLIC API (consumed by CI/editors/etc.),
 * so it is just the `FairUxReport` envelope verbatim — no reshaping.
 */
export function toJson(report: FairUxReport, options: JsonReportOptions = {}): string {
  return JSON.stringify(report, null, options.pretty === false ? undefined : 2);
}
