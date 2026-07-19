import type {
  Evidence,
  FairUxBatchReport,
  FairUxReport,
  Finding,
  NodeLocator,
  Severity,
  SourceLocation,
} from "@fairux/core";
import { DISCLAIMER } from "./disclaimer.js";
import { sanitizeInlineCode, sanitizeMarkdownText, sanitizePath } from "./sanitize.js";

const SEVERITY_ORDER: Severity[] = ["high", "medium", "low", "info"];

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function locatorToString(locator: NodeLocator): string {
  switch (locator.type) {
    case "css":
      return sanitizeInlineCode(locator.value);
    case "path":
      return `path ${sanitizeInlineCode(locator.value.join(","))}`;
    case "ast":
      return `${sanitizeInlineCode(locator.file)}:${locator.startLine}:${locator.startColumn}`;
    case "figma":
      return `figma:${sanitizeInlineCode(locator.nodeId)}`;
  }
}

function sourceToString(source: SourceLocation): string | undefined {
  if (source.startLine != null) {
    return source.file
      ? `${sanitizePath(source.file)}:${source.startLine}`
      : `line ${source.startLine}`;
  }
  return source.file ? sanitizePath(source.file) : undefined;
}

function formatEvidence(evidence: Evidence): string {
  const parts: string[] = [];
  if (evidence.locator) parts.push(`\`${locatorToString(evidence.locator)}\``);
  if (evidence.text) parts.push(`"${sanitizeMarkdownText(evidence.text)}"`);
  let line = parts.join(" — ") || "(evidence)";
  const source = evidence.source ? sourceToString(evidence.source) : undefined;
  if (source) line += ` (${source})`;
  return line;
}

function renderFinding(finding: Finding): string[] {
  const lines = [
    `### ${sanitizeMarkdownText(finding.title)}`,
    `- **Rule:** \`${sanitizeInlineCode(finding.ruleId)}\``,
    `- **Severity:** ${finding.severity}  **Confidence:** ${finding.confidence}`,
    `- **What:** ${sanitizeMarkdownText(finding.description)}`,
    `- **Why it matters:** ${sanitizeMarkdownText(finding.whyItMatters)}`,
    `- **Recommendation:** ${sanitizeMarkdownText(finding.recommendation)}`,
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

function renderRulePacks(
  rulePacks: FairUxReport["rulePacks"] | FairUxBatchReport["rulePacks"],
): string[] {
  if (!rulePacks || rulePacks.length === 0) return [];
  return [
    "**Rule packs:**",
    ...rulePacks.map(
      (pack) => `- \`${sanitizeInlineCode(pack.id)}\` ${sanitizeMarkdownText(pack.version)}`,
    ),
    "",
  ];
}

/** Render a report as a readable Markdown document (disclaimer + severity-grouped findings). */
export function toMarkdown(report: FairUxReport): string {
  const s = report.summary;
  const lines: string[] = ["# FairUX Report", "", `> ${DISCLAIMER}`, ""];
  if (report.input.file) lines.push(`**File:** ${sanitizePath(report.input.file)}`);
  lines.push(`**Runtime:** ${report.input.runtime}`);
  lines.push(`**Generated:** ${report.generatedAt}`);
  lines.push(...renderRulePacks(report.rulePacks));
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

/** Render a batch report as a readable Markdown document (disclaimer + per-file findings). */
export function toBatchMarkdown(report: FairUxBatchReport): string {
  const s = report.summary;
  const lines: string[] = ["# FairUX Batch Report", "", `> ${DISCLAIMER}`, ""];
  lines.push(`**Generated:** ${report.generatedAt}`);
  lines.push(...renderRulePacks(report.rulePacks));
  lines.push(
    `**Total Findings:** ${s.total} (high: ${s.bySeverity.high}, medium: ${s.bySeverity.medium}, low: ${s.bySeverity.low}, info: ${s.bySeverity.info})`,
    "",
  );

  if (s.byRuntime) {
    lines.push("## By Runtime", "");
    for (const [runtime, runtimeSummary] of Object.entries(s.byRuntime)) {
      lines.push(
        `**${runtime}:** ${runtimeSummary.total} (high: ${runtimeSummary.bySeverity.high}, medium: ${runtimeSummary.bySeverity.medium}, low: ${runtimeSummary.bySeverity.low}, info: ${runtimeSummary.bySeverity.info})`,
      );
    }
    lines.push("");
  }

  if (report.reports.length === 0) {
    lines.push("No findings.");
    return `${lines.join("\n")}\n`;
  }

  for (const [i, subReport] of report.reports.entries()) {
    const input = report.inputs[i];
    if (!input) continue;
    const fileName = input.file || input.figmaFile || "(unknown)";
    const safeFileName = sanitizeInlineCode(sanitizePath(fileName));
    const runtime = input.runtime || "unknown";
    lines.push(`## File ${i + 1}: \`${safeFileName}\``, "");
    lines.push(`**Runtime:** ${runtime}`);
    lines.push(
      `**Findings:** ${subReport.summary.total} (high: ${subReport.summary.bySeverity.high}, medium: ${subReport.summary.bySeverity.medium}, low: ${subReport.summary.bySeverity.low}, info: ${subReport.summary.bySeverity.info})`,
      "",
    );

    if (subReport.findings.length === 0) {
      lines.push("No findings for this file.", "");
      continue;
    }

    for (const severity of SEVERITY_ORDER) {
      const group = subReport.findings.filter((f) => f.severity === severity);
      if (group.length === 0) continue;
      lines.push(`### ${capitalize(severity)}`, "");
      for (const finding of group) lines.push(...renderFinding(finding));
    }
    lines.push("");
  }

  return `${lines.join("\n").trimEnd()}\n`;
}
