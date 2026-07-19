import type {
  Evidence,
  FairUxReport,
  Finding,
  NodeLocator,
  Severity,
  SourceLocation,
} from "@fairux/core";
import { DISCLAIMER } from "./disclaimer.js";

const SEVERITY_ORDER: Severity[] = ["high", "medium", "low", "info"];

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function locatorToString(locator: NodeLocator): string {
  switch (locator.type) {
    case "css":
      return locator.value;
    case "path":
      return `path ${locator.value.join(",")}`;
    case "ast":
      return `${locator.file}:${locator.startLine}:${locator.startColumn}`;
    case "figma":
      return `figma:${locator.nodeId}`;
  }
}

function sourceToString(source: SourceLocation): string | undefined {
  if (source.startLine != null) {
    return source.file ? `${source.file}:${source.startLine}` : `line ${source.startLine}`;
  }
  return source.file;
}

function formatEvidence(evidence: Evidence): string {
  const parts: string[] = [];
  if (evidence.locator) parts.push(`\`${locatorToString(evidence.locator)}\``);
  if (evidence.text) parts.push(`"${evidence.text}"`);
  let line = parts.join(" — ") || "(evidence)";
  const source = evidence.source ? sourceToString(evidence.source) : undefined;
  if (source) line += ` (${source})`;
  return line;
}

function renderFinding(finding: Finding): string[] {
  const lines = [
    `### ${finding.title}`,
    `- **Rule:** \`${finding.ruleId}\``,
    `- **Severity:** ${finding.severity}  **Confidence:** ${finding.confidence}`,
    `- **What:** ${finding.description}`,
    `- **Why it matters:** ${finding.whyItMatters}`,
    `- **Recommendation:** ${finding.recommendation}`,
  ];
  if (finding.evidence.length > 0) {
    lines.push("- **Evidence:**");
    for (const e of finding.evidence) lines.push(`  - ${formatEvidence(e)}`);
  }
  if (finding.references && finding.references.length > 0) {
    lines.push(`- **References:** ${finding.references.join(", ")}`);
  }
  lines.push("");
  return lines;
}

/** Render a report as a readable Markdown document (disclaimer + severity-grouped findings). */
export function toMarkdown(report: FairUxReport): string {
  const s = report.summary;
  const lines: string[] = ["# FairUX Report", "", `> ${DISCLAIMER}`, ""];
  if (report.input.file) lines.push(`**File:** ${report.input.file}`);
  lines.push(`**Runtime:** ${report.input.runtime}`);
  lines.push(`**Generated:** ${report.generatedAt}`);
  lines.push(
    `**Findings:** ${s.total} (high: ${s.bySeverity.high}, medium: ${s.bySeverity.medium}, low: ${s.bySeverity.low}, info: ${s.bySeverity.info})`,
    "",
  );

  if (report.findings.length === 0) {
    lines.push("No findings.");
    return `${lines.join("\n")}\n`;
  }

  for (const severity of SEVERITY_ORDER) {
    const group = report.findings.filter((f) => f.severity === severity);
    if (group.length === 0) continue;
    lines.push(`## ${capitalize(severity)}`, "");
    for (const finding of group) lines.push(...renderFinding(finding));
  }

  return `${lines.join("\n").trimEnd()}\n`;
}
