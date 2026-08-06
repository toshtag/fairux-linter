import type {
  Evidence,
  FairUxBatchReport,
  FairUxReport,
  Finding,
  JourneyReport,
  NodeLocator,
  ScanCoverage,
  Severity,
  SourceLocation,
} from "@fairux/core";
import { COVERAGE_NOTE, orNone, toCoverageView } from "./coverage-view.js";
import { DISCLAIMER } from "./disclaimer.js";
import {
  externalFilterViews,
  FILTERS_HEADING,
  FILTERS_NOTE,
  hasExternalFilters,
} from "./external-filter-view.js";
import { sanitizeInlineCode, sanitizeMarkdownText, sanitizePath } from "./sanitize.js";
import {
  DIAGNOSTICS_HEADING,
  DIAGNOSTICS_NOTE,
  diagnosticLines,
  hasSuppressionRecord,
  SUPPRESSED_HEADING,
  SUPPRESSED_NOTE,
  suppressedLines,
} from "./suppression-view.js";

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
  // Named first for a journey finding: the same locator exists on every step, so the step is what
  // turns "somewhere in this flow" into somewhere a reader can go.
  if (evidence.stepId) parts.push(`step \`${sanitizeInlineCode(evidence.stepId)}\``);
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
    `- **Category:** \`${sanitizeInlineCode(finding.category)}\``,
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

/**
 * The coverage section: what the scan could check, in counts and lists.
 *
 * Deliberately no ratio. "9 of 13" is one division away from a score, and a score reported without
 * the coverage beside it is the thing this milestone exists to prevent.
 *
 * Skipped rules are named; executed ones are counted. The JSON report lists every rule, and a reader
 * of the Markdown one needs the exceptions rather than the roll call.
 */
function renderCoverage(coverage: ScanCoverage | undefined, heading: string): string[] {
  if (!coverage) return [];
  const view = toCoverageView(coverage);
  const lines: string[] = [heading, ""];
  lines.push(`- **Capabilities available:** ${orNone(view.available)}`);
  lines.push(`- **Capabilities unavailable:** ${orNone(view.unavailable)}`);
  lines.push(
    `- **Rules:** ${view.counts.executed} ran, ${view.counts.skipped} skipped, ` +
      `${view.counts.total - view.counts.eligible} not enabled, of ${view.counts.total} in the rule set`,
  );

  for (const group of view.skipped) {
    lines.push(`- **${group.label}:**`);
    for (const rule of group.rules) {
      const missing =
        rule.missingCapabilities.length > 0
          ? ` — needs ${rule.missingCapabilities.join(", ")}`
          : "";
      lines.push(`  - \`${sanitizeInlineCode(rule.ruleId)}\`${missing}`);
    }
  }

  if (view.degraded.length > 0) {
    lines.push("- **Ran without optional evidence:**");
    for (const rule of view.degraded) {
      lines.push(
        `  - \`${sanitizeInlineCode(rule.ruleId)}\` — no ${rule.missingOptionalCapabilities.join(", ")}`,
      );
    }
  }

  lines.push("", `> ${COVERAGE_NOTE}`, "");
  return lines;
}

/** Render a report as a readable Markdown document (disclaimer + severity-grouped findings). */
/**
 * What an inline directive removed, and what one failed to remove.
 *
 * Rendered whether or not there are findings, and *after* them so a reader meets the report first —
 * but never omitted. Markdown and HTML are the surfaces a person reads, and both used to render a
 * page whose consent rule had been turned off on line 4 exactly like a page with no directive at
 * all.
 */
function renderSuppressions(
  record: {
    readonly suppressed?: FairUxReport["suppressed"];
    readonly suppressionDiagnostics?: FairUxReport["suppressionDiagnostics"];
  },
  heading: string,
): string[] {
  if (!hasSuppressionRecord(record)) return [];
  const lines: string[] = [];
  const suppressed = suppressedLines(record.suppressed);
  if (suppressed.length > 0) {
    lines.push(`${heading} ${SUPPRESSED_HEADING}`, "", `> ${SUPPRESSED_NOTE}`, "");
    for (const entry of suppressed) {
      lines.push(
        `- \`${sanitizeInlineCode(entry.ruleId)}\` at line ${entry.line} — ` +
          `${sanitizeMarkdownText(entry.reason)}`,
      );
    }
    lines.push("");
  }
  const diagnostics = diagnosticLines(record.suppressionDiagnostics);
  if (diagnostics.length > 0) {
    lines.push(`${heading} ${DIAGNOSTICS_HEADING}`, "", `> ${DIAGNOSTICS_NOTE}`, "");
    for (const entry of diagnostics) {
      lines.push(`- line ${entry.line} (${entry.kind}) — ${sanitizeMarkdownText(entry.message)}`);
    }
    lines.push("");
  }
  return lines;
}

/**
 * What a `--suppress` or `--baseline` file removed, on the surface a person reads.
 *
 * Report-level, not per finding: a filter file is applied to the run. Rendered last, after the
 * findings and after the inline directives, because it is the answer to "is this everything?" —
 * which is a question a reader asks once they have read the report.
 */
function renderExternalFilters(
  record: { readonly externalFilters?: FairUxReport["externalFilters"] },
  heading: string,
): string[] {
  if (!hasExternalFilters(record)) return [];
  const lines: string[] = [`${heading} ${FILTERS_HEADING}`, "", `> ${FILTERS_NOTE}`, ""];
  for (const view of externalFilterViews(record.externalFilters)) {
    lines.push(
      `**${view.kind}** \`${sanitizeInlineCode(sanitizePath(view.file))}\` — ${view.counts}`,
      "",
      `\`${sanitizeInlineCode(view.digest)}\`${view.identity ? ` · ${sanitizeMarkdownText(view.identity)}` : ""}`,
      "",
    );
    for (const entry of view.groups) {
      lines.push(`${sanitizeMarkdownText(entry.label)}:`, "");
      for (const line of entry.entries) lines.push(`- ${sanitizeMarkdownText(line)}`);
      lines.push("");
    }
  }
  return lines;
}

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

  // Before the findings, and before the early return below: an empty findings list is exactly the
  // case where a reader needs to know how much was looked at.
  lines.push(...renderCoverage(report.coverage, "## Coverage"));

  if (report.findings.length === 0) {
    lines.push("No findings.", "");
    // Still rendered: "no findings" and "no findings because two were turned off on line 4" are
    // different reports, and this is the one place the difference is visible.
    lines.push(...renderSuppressions(report, "##"));
    lines.push(...renderExternalFilters(report, "##"));
    return `${lines.join("\n").trimEnd()}\n`;
  }

  for (const severity of SEVERITY_ORDER) {
    const group = report.findings.filter((f) => f.severity === severity);
    if (group.length === 0) continue;
    lines.push(`## ${capitalize(severity)}`, "");
    for (const finding of group) lines.push(...renderFinding(finding));
  }

  lines.push(...renderSuppressions(report, "##"));
  lines.push(...renderExternalFilters(report, "##"));

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
    lines.push(...renderExternalFilters(report, "##"));
    return `${lines.join("\n").trimEnd()}\n`;
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

    lines.push(...renderCoverage(subReport.coverage, "### Coverage"));

    if (subReport.findings.length === 0) {
      lines.push("No findings for this file.", "");
      lines.push(...renderSuppressions(subReport, "###"));
      continue;
    }

    for (const severity of SEVERITY_ORDER) {
      const group = subReport.findings.filter((f) => f.severity === severity);
      if (group.length === 0) continue;
      lines.push(`### ${capitalize(severity)}`, "");
      for (const finding of group) lines.push(...renderFinding(finding));
    }
    lines.push(...renderSuppressions(subReport, "###"));
    lines.push("");
  }

  // At the batch root, matching where the record lives: a filter file is applied to the run rather
  // than to any one of its inputs.
  lines.push(...renderExternalFilters(report, "##"));

  return `${lines.join("\n").trimEnd()}\n`;
}

/**
 * The sentence that keeps the two layers from being read as one.
 *
 * A journey report carries two counts of two different things. Printing them without saying how they
 * relate leaves a reader to guess, and the two available guesses — that one contains the other, or
 * that they may be added — are not both right. They are disjoint, so the total is their sum, and
 * saying so is better than withholding the total and hoping nobody adds them.
 */
const LAYER_NOTE =
  "**Across the flow** counts findings that exist only between steps. **Within steps** counts each " +
  "step's own findings. No finding appears in both, so the total below is their sum.";

function severityLine(summary: { total: number; bySeverity: Record<Severity, number> }): string {
  const s = summary.bySeverity;
  return `${summary.total} (high: ${s.high}, medium: ${s.medium}, low: ${s.low}, info: ${s.info})`;
}

/**
 * Render a journey as Markdown: the flow's own findings, then each step's, never merged.
 *
 * There is no combined findings list. A journey rule reporting a problem that spans the pricing page
 * and the checkout is a different fact from the checkout's own pre-checked box, and one list sorted
 * by severity would present them as the same kind of thing.
 */
export function toJourneyMarkdown(report: JourneyReport): string {
  const lines: string[] = ["# FairUX Journey Report", "", `> ${DISCLAIMER}`, ""];
  lines.push(`**Generated:** ${report.generatedAt}`);
  lines.push(`**Steps:** ${report.steps.length}`);
  lines.push(...renderRulePacks(report.rulePacks));
  lines.push(
    `**Across the flow:** ${severityLine(report.summary)}`,
    `**Within steps:** ${severityLine(report.stepSummary)}`,
    `**Total:** ${report.summary.total + report.stepSummary.total}`,
    "",
    `> ${LAYER_NOTE}`,
    "",
  );

  lines.push(...renderCoverage(report.coverage, "## Coverage across the flow"));

  lines.push("## Across the flow", "");
  // The distinction the count alone cannot carry: no journey rule ran because there are none, and
  // no journey rule found anything, produce the same `0` and mean opposite things.
  const journeyRuleCount = report.coverage?.summary.total ?? 0;
  if (journeyRuleCount === 0) {
    lines.push(
      "**Nothing was checked here.** The rule set contains no journey rule, so the flow between " +
        "steps was not examined at all — a zero above is the absence of a check, not a clean result. " +
        "Each step below was scanned on its own.",
      "",
    );
  } else if (report.findings.length === 0) {
    lines.push(
      "No cross-step findings. This is not a statement that the flow is sound — it is what the " +
        "journey rules in the current rule set could check.",
      "",
    );
  } else {
    for (const severity of SEVERITY_ORDER) {
      const group = report.findings.filter((finding) => finding.severity === severity);
      if (group.length === 0) continue;
      lines.push(`### ${capitalize(severity)}`, "");
      for (const finding of group) lines.push(...renderFinding(finding));
    }
  }

  for (const step of report.steps) {
    const where = step.url ?? step.location;
    lines.push(
      `## Step ${step.order}: \`${sanitizeInlineCode(step.id)}\`` +
        (where ? ` — ${sanitizeMarkdownText(where)}` : ""),
      "",
    );
    // No action label: `JourneyStepReport` carries the step's id, order, url, and location, and not
    // what the user did to reach the next one. Rendering something the report does not hold would
    // mean reading it back off the input, which is how a renderer starts disagreeing with its data.
    lines.push(`**Findings:** ${severityLine(step.report.summary)}`, "");
    lines.push(...renderCoverage(step.report.coverage, "### Coverage"));

    if (step.report.findings.length === 0) {
      lines.push("No findings for this step.", "");
      continue;
    }
    for (const severity of SEVERITY_ORDER) {
      const group = step.report.findings.filter((finding) => finding.severity === severity);
      if (group.length === 0) continue;
      lines.push(`### ${capitalize(severity)}`, "");
      for (const finding of group) lines.push(...renderFinding(finding));
    }
  }

  return `${lines.join("\n").trimEnd()}\n`;
}
