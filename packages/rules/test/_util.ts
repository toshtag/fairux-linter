import { type FairUxReport, type Rule, type ScanOptions, scan } from "@fairux/core";
import { parseHtml } from "@fairux/html";
import { dictionary } from "../src/index.js";

/** Parse HTML and scan it with the given rules + the shipped dictionary. */
export function run(html: string, rules: readonly Rule[], options: ScanOptions = {}): FairUxReport {
  return scan(parseHtml(html), rules, { dictionary, ...options });
}

export function ruleIds(report: FairUxReport): string[] {
  return report.findings.map((f) => f.ruleId);
}

export function findingsFor(report: FairUxReport, ruleId: string) {
  return report.findings.filter((f) => f.ruleId === ruleId);
}
