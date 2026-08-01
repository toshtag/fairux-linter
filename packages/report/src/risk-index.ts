import type { RiskIndexReport } from "@fairux/core";
import { toRiskIndexView } from "./risk-index-view.js";
import { sanitizeInlineCode, sanitizeMarkdownText } from "./sanitize.js";

/**
 * Rendering a Risk Index.
 *
 * JSON is canonical: everything here is a display of a report someone else computed, and nothing
 * here derives, rounds, or infers a value. A surface that computed its own number would be a second
 * model nobody versioned.
 */

/** Markdown for a Risk Index report. Shows a number only when the report carries one. */
export function toRiskIndexMarkdown(report: RiskIndexReport): string {
  const view = toRiskIndexView(report);
  const lines: string[] = [
    "# FairUX Risk Index",
    "",
    `**Score:** ${view.score ?? view.scorePlaceholder}  **Confidence:** ${view.confidence}`,
    `**Status:** ${view.statusLabel}`,
  ];
  if (view.reason) lines.push(`**Why there is no score:** ${sanitizeMarkdownText(view.reason)}`);
  lines.push(
    `**Model:** \`${sanitizeInlineCode(view.modelVersion)}\``,
    `**Schema:** ${report.versions.schemaVersion}  **Tool:** ${sanitizeMarkdownText(report.versions.toolVersion)}`,
    "",
    "## Coverage",
    "",
    `- **Inputs:** ${view.coverage.documents}${
      view.coverage.journeySteps !== undefined
        ? ` (journey steps: ${view.coverage.journeySteps})`
        : ""
    }`,
    `- **Rules:** ${view.coverage.rules.executed} ran, ${view.coverage.rules.skipped} skipped, of ${view.coverage.rules.total}`,
  );
  if (view.coverage.requiredCapabilities.length > 0) {
    lines.push(`- **Model requires:** ${view.coverage.requiredCapabilities.join(", ")}`);
  }
  if (view.coverage.missingCapabilities.length > 0) {
    lines.push(`- **Missing:** ${view.coverage.missingCapabilities.join(", ")}`);
  }
  lines.push(`- **Findings a score would rest on:** ${view.contributingFindingCount}`);

  lines.push("", "## What this does not mean", "");
  for (const limitation of view.limitations) lines.push(`- ${sanitizeMarkdownText(limitation)}`);

  return `${lines.join("\n")}\n`;
}

/**
 * The Risk Index as SARIF run-level property-bag data.
 *
 * Never a result. A score is not a finding — inventing one would put a number where a consumer
 * expects an alert with a location, and every SARIF consumer that counts results would count it.
 */
export function riskIndexSarifProperties(report: RiskIndexReport): Record<string, unknown> {
  const view = toRiskIndexView(report);
  return {
    riskIndex: {
      schemaVersion: report.versions.schemaVersion,
      modelVersion: report.versions.modelVersion,
      status: report.status,
      // Copied from the report rather than from the view: SARIF consumers are machines, and `null`
      // is the accurate value where a human surface shows a dash.
      score: report.score,
      confidence: report.confidence,
      ...(report.reason ? { reason: report.reason } : {}),
      coverage: report.coverage,
      contributingFindingCount: view.contributingFindingCount,
      limitations: report.limitations,
    },
  };
}
