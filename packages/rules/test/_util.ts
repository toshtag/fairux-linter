import { type FairUxReport, type Rule, scan } from "@fairux/core";
import { parseHtml } from "@fairux/html";
import { dictionary } from "../src/index.js";

/** Parse HTML and scan it with the given rules + the shipped dictionary. */
export function run(html: string, rules: Rule[]): FairUxReport {
  return scan(parseHtml(html), rules, { dictionary });
}

export function ruleIds(report: FairUxReport): string[] {
  return report.findings.map((f) => f.ruleId);
}

export function findingsFor(report: FairUxReport, ruleId: string) {
  return report.findings.filter((f) => f.ruleId === ruleId);
}
