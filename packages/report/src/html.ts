import type {
  Evidence,
  FairUxBatchReport,
  FairUxReport,
  Finding,
  RiskIndexReport,
  ScanCoverage,
  Severity,
} from "@fairux/core";
import { COVERAGE_NOTE, orNone, toCoverageView } from "./coverage-view.js";
import { DISCLAIMER } from "./disclaimer.js";
import {
  externalFilterViews,
  FILTERS_HEADING,
  FILTERS_NOTE,
  hasExternalFilters,
} from "./external-filter-view.js";
import { toRiskIndexView } from "./risk-index-view.js";
import {
  DIAGNOSTICS_HEADING,
  DIAGNOSTICS_NOTE,
  diagnosticLines,
  hasSuppressionRecord,
  SUPPRESSED_HEADING,
  SUPPRESSED_NOTE,
  suppressedLines,
} from "./suppression-view.js";

/**
 * A single, self-contained HTML report.
 *
 * **Everything in a finding is untrusted text from the scanned page.** Evidence snippets are
 * literally markup FairUX found, and a report that interpolated any of it unescaped would execute
 * the scanned site's script the moment a reviewer opened it. A linter that ships an XSS is worse
 * than no linter, so escaping here is the *only* path a value can take: `html` is a tagged template
 * that escapes every interpolation, and the one way to bypass it — {@link raw} — is used solely for
 * fragments this file built itself.
 *
 * Self-contained, and that is a property rather than a convenience. No script, no external
 * stylesheet, no font, no image, no remote URL of any kind: the report has to render as an artifact,
 * an email attachment, or in an air-gapped review, and one that needs the network does not. It also
 * means the file cannot phone home about what was scanned.
 *
 * No interactivity at all. A report that needs JavaScript to reveal its contents cannot be printed
 * or pasted, and "no script" is a claim a test can check.
 *
 * Browser-safe: no Node built-ins, like the rest of `@fairux/report`.
 */

const SEVERITY_ORDER: readonly Severity[] = ["high", "medium", "low", "info"];

/** A fragment this module built. The only way to reach the output unescaped. */
class RawHtml {
  constructor(readonly value: string) {}
}

/** Mark a fragment as already-safe. Never call this with anything derived from a report. */
function raw(value: string): RawHtml {
  return new RawHtml(value);
}

/**
 * Escape one value for HTML text or a quoted attribute.
 *
 * All five characters, not the usual three. `"` and `'` are what turn an interpolation inside an
 * attribute into a new attribute, which is the breakout that matters here — evidence text routinely
 * contains quotes because it is markup.
 */
function escapeHtml(value: unknown): string {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/**
 * Tagged template that escapes every interpolation.
 *
 * Escaping is the default rather than something remembered per call site: the failure mode of the
 * opposite arrangement is one forgotten interpolation among dozens, which is how this class of bug
 * always happens.
 */
function html(strings: TemplateStringsArray, ...values: unknown[]): RawHtml {
  let out = strings[0] ?? "";
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value instanceof RawHtml) out += value.value;
    else if (Array.isArray(value)) {
      out += value
        .map((item) => (item instanceof RawHtml ? item.value : escapeHtml(item)))
        .join("");
    } else out += escapeHtml(value);
    out += strings[index + 1] ?? "";
  }
  return raw(out);
}

/** No `url()`, no `@import`, no font — nothing here reaches the network. */
const STYLE = `
:root { color-scheme: light dark; }
body { margin: 0; padding: 2rem 1.5rem; font-family: system-ui, sans-serif; line-height: 1.55;
  max-width: 60rem; margin-inline: auto; }
h1 { font-size: 1.5rem; margin: 0 0 .25rem; }
h2 { font-size: 1.1rem; margin: 2rem 0 .5rem; text-transform: capitalize; }
.disclaimer { border: 1px solid currentColor; border-radius: .35rem; padding: .6rem .8rem;
  margin: 1rem 0 1.5rem; font-weight: 600; }
.meta { margin: 0 0 1.5rem; padding: 0; list-style: none; font-size: .9rem; opacity: .85; }
.meta li { margin: .15rem 0; }
.finding { border: 1px solid currentColor; border-radius: .35rem; padding: .9rem 1rem;
  margin: 0 0 .9rem; }
.finding h3 { margin: 0 0 .35rem; font-size: 1rem; }
.rule { font-family: ui-monospace, monospace; font-size: .85rem; opacity: .85; }
.badge { display: inline-block; border: 1px solid currentColor; border-radius: .2rem;
  padding: 0 .35rem; font-size: .75rem; text-transform: uppercase; letter-spacing: .04em; }
.finding dl { margin: .6rem 0 0; }
.finding dt { font-weight: 600; font-size: .85rem; margin-top: .5rem; }
.finding dd { margin: .1rem 0 0; }
.evidence { font-family: ui-monospace, monospace; font-size: .85rem; white-space: pre-wrap;
  word-break: break-word; border-left: 3px solid currentColor; padding-left: .6rem; margin: .3rem 0; }
.empty { opacity: .8; }
.coverage { border: 1px solid currentColor; border-radius: .35rem; padding: .8rem 1rem;
  margin: 0 0 1.5rem; }
.coverage h2 { margin: 0 0 .5rem; font-size: 1rem; }
.coverage dl { margin: 0; display: grid; grid-template-columns: max-content 1fr; gap: .2rem .8rem; }
.coverage dt { font-weight: 600; font-size: .85rem; }
.coverage dd { margin: 0; font-size: .85rem; }
.coverage ul { margin: .1rem 0; padding-left: 1.1rem; }
.coverage .note { margin: .7rem 0 0; font-size: .85rem; opacity: .85; }
.suppressions { margin-top: 1.4rem; padding-top: 1rem; border-top: 1px solid #e5e7eb; }
.suppressions h3 { margin: 1rem 0 .3rem; font-size: 1rem; }
.suppressions .note { margin: 0 0 .5rem; font-size: .85rem; opacity: .85; }
.filters { margin-top: 1.4rem; padding-top: 1rem; border-top: 1px solid #e5e7eb; }
.filters h3 { margin: 1rem 0 .2rem; font-size: 1rem; }
.filters h4 { margin: .7rem 0 .2rem; font-size: .9rem; }
.filters .note, .filters .about { margin: 0 0 .5rem; font-size: .85rem; opacity: .85; }
.filters code { word-break: break-all; }
.risk { border: 1px solid currentColor; border-radius: .35rem; padding: .8rem 1rem;
  margin: 0 0 1.5rem; }
.risk h2 { margin: 0 0 .4rem; font-size: 1rem; }
.risk .score { font-size: 2rem; font-weight: 700; line-height: 1.1; }
.risk .about { margin: .2rem 0 0; font-size: .85rem; opacity: .85; }
.risk ul { margin: .6rem 0 0; padding-left: 1.1rem; font-size: .85rem; }
`.trim();

function severityBadge(severity: Severity): RawHtml {
  return html`<span class="badge">${severity}</span>`;
}

function evidenceItem(evidence: Evidence): RawHtml {
  const where = evidence.source?.file
    ? `${evidence.source.file}${evidence.source.startLine ? `:${evidence.source.startLine}` : ""}`
    : (evidence.locator?.type ?? "");
  return html`<p class="evidence">${where ? html`${where} — ` : raw("")}${evidence.snippet ?? ""}</p>`;
}

function findingSection(finding: Finding): RawHtml {
  return html`<article class="finding">
  <h3>${severityBadge(finding.severity)} ${finding.title}</h3>
  <p class="rule">${finding.ruleId} · confidence ${finding.confidence} · ${finding.category}</p>
  <dl>
    <dt>What was found</dt><dd>${finding.description}</dd>
    <dt>Why it matters</dt><dd>${finding.whyItMatters}</dd>
    <dt>Recommendation</dt><dd>${finding.recommendation}</dd>
    <dt>Evidence</dt><dd>${finding.evidence.map(evidenceItem)}</dd>
  </dl>
</article>`;
}

function severityGroups(findings: readonly Finding[]): RawHtml[] {
  const groups: RawHtml[] = [];
  for (const severity of SEVERITY_ORDER) {
    const group = findings.filter((finding) => finding.severity === severity);
    if (group.length === 0) continue;
    groups.push(html`<h2>${severity}</h2>${group.map(findingSection)}`);
  }
  return groups;
}

/**
 * The coverage panel: what the scan could check.
 *
 * Counts, never a ratio. The reader who wants one number is the reader this project keeps declining
 * to serve until the Risk Index exists with its coverage attached, and a rendered percentage here
 * would be that number by another route.
 */
function coveragePanel(coverage: ScanCoverage | undefined, heading: string): RawHtml {
  if (!coverage) return raw("");
  const view = toCoverageView(coverage);
  const rows: RawHtml[] = [
    html`<dt>Available</dt><dd>${orNone(view.available)}</dd>`,
    html`<dt>Unavailable</dt><dd>${orNone(view.unavailable)}</dd>`,
    html`<dt>Rules</dt><dd>${view.counts.executed} ran, ${view.counts.skipped} skipped, ${view.counts.total - view.counts.eligible} not enabled, of ${view.counts.total} in the rule set</dd>`,
  ];

  for (const group of view.skipped) {
    rows.push(
      html`<dt>${group.label}</dt><dd><ul>${group.rules.map(
        (rule) =>
          html`<li>${rule.ruleId}${
            rule.missingCapabilities.length > 0
              ? html` — needs ${rule.missingCapabilities.join(", ")}`
              : raw("")
          }</li>`,
      )}</ul></dd>`,
    );
  }

  if (view.degraded.length > 0) {
    rows.push(
      html`<dt>Ran without optional evidence</dt><dd><ul>${view.degraded.map(
        (rule) => html`<li>${rule.ruleId} — no ${rule.missingOptionalCapabilities.join(", ")}</li>`,
      )}</ul></dd>`,
    );
  }

  return html`<section class="coverage">
<h2>${heading}</h2>
<dl>${rows}</dl>
<p class="note">${COVERAGE_NOTE}</p>
</section>`;
}

/**
 * The Risk Index panel.
 *
 * Reads `toRiskIndexView` rather than the report, like every other surface: the whole point of that
 * view is that a renderer cannot print a number the report does not carry, and this is the surface
 * where a stray `0` would be read as a result and screenshotted.
 *
 * The limitations render with the number rather than below the findings. A score that travels
 * without them is the thing this design exists to prevent, and a reader who scrolls no further has
 * still seen them.
 */
/**
 * What an inline directive removed, and what one failed to remove.
 *
 * Rendered whether or not there are findings. An HTML report is what a reviewer opens, and one for a
 * page whose consent rule had been turned off on line 4 used to look exactly like one for a page
 * with no directive at all — the finding never reaches `findings`, so nothing on this surface said
 * so. Every value is escaped on the way in, like the rest of this document: a reason is text an
 * author wrote into the page being scanned.
 */
function suppressionPanel(record: {
  readonly suppressed?: FairUxReport["suppressed"];
  readonly suppressionDiagnostics?: FairUxReport["suppressionDiagnostics"];
}): RawHtml {
  if (!hasSuppressionRecord(record)) return raw("");
  const suppressed = suppressedLines(record.suppressed);
  const diagnostics = diagnosticLines(record.suppressionDiagnostics);
  const suppressedBlock =
    suppressed.length === 0
      ? raw("")
      : html`<h3>${SUPPRESSED_HEADING}</h3>
<p class="note">${SUPPRESSED_NOTE}</p>
<ul>${suppressed.map(
          (entry) =>
            html`<li><code>${entry.ruleId}</code> at line ${entry.line} — ${entry.reason}${
              entry.fingerprint ? html` <code>[${entry.fingerprint}]</code>` : raw("")
            }</li>`,
        )}</ul>`;
  const diagnosticBlock =
    diagnostics.length === 0
      ? raw("")
      : html`<h3>${DIAGNOSTICS_HEADING}</h3>
<p class="note">${DIAGNOSTICS_NOTE}</p>
<ul>${diagnostics.map(
          (entry) => html`<li>line ${entry.line} (${entry.kind}) — ${entry.message}</li>`,
        )}</ul>`;
  return html`<section class="suppressions">${suppressedBlock}${diagnosticBlock}</section>`;
}

/**
 * What a `--suppress` or `--baseline` file removed, on the surface a reviewer opens.
 *
 * An HTML report is what gets attached to a ticket, and one for a run that subtracted twelve
 * findings looked exactly like one for a run that found none. The accounting existed and went to
 * stderr, which no attachment carries. Every value is escaped like the rest of this document — a
 * path and a reason are both strings somebody else wrote.
 */
function externalFilterPanel(record: {
  readonly externalFilters?: FairUxReport["externalFilters"];
}): RawHtml {
  if (!hasExternalFilters(record)) return raw("");
  const views = externalFilterViews(record.externalFilters);
  return html`<section class="filters">
<h2>${FILTERS_HEADING}</h2>
<p class="note">${FILTERS_NOTE}</p>
${views.map(
  (view) => html`<div class="filter">
<h3>${view.kind} — <code>${view.file}</code></h3>
<p class="about">${view.counts} · <code>${view.digest}</code>${
    view.identity ? html` · ${view.identity}` : raw("")
  }</p>
${view.groups.map(
  (entry) => html`<h4>${entry.label}</h4>
<ul>${entry.entries.map((line) => html`<li>${line}</li>`)}</ul>`,
)}</div>`,
)}</section>`;
}

function riskIndexPanel(riskIndex: RiskIndexReport | undefined): RawHtml {
  if (!riskIndex) return raw("");
  const view = toRiskIndexView(riskIndex);
  return html`<section class="risk">
<h2>FairUX Risk Index</h2>
<p class="score">${view.score ?? view.scorePlaceholder}</p>
<p class="about">${view.statusLabel} · confidence ${view.confidence} · model ${view.modelVersion}${
    view.reason ? html` · ${view.reason}` : raw("")
  }</p>
<ul>${view.limitations.map((limitation) => html`<li>${limitation}</li>`)}</ul>
</section>`;
}

function summaryItems(report: FairUxReport | FairUxBatchReport): RawHtml[] {
  const summary = report.summary;
  const items: RawHtml[] = [];
  if ("input" in report) {
    if (report.input.file) items.push(html`<li>File: ${report.input.file}</li>`);
    items.push(html`<li>Runtime: ${report.input.runtime}</li>`);
  } else {
    items.push(html`<li>Files scanned: ${report.inputs.length}</li>`);
  }
  items.push(html`<li>Generated: ${report.generatedAt}</li>`);
  items.push(html`<li>Tool version: ${report.toolVersion}</li>`);
  for (const pack of report.rulePacks ?? []) {
    items.push(html`<li>Rule pack: ${pack.id}@${pack.version}</li>`);
  }
  items.push(
    html`<li>Findings: ${summary.total} (high ${summary.bySeverity.high}, medium ${summary.bySeverity.medium}, low ${summary.bySeverity.low}, info ${summary.bySeverity.info})</li>`,
  );
  return items;
}

function document(title: string, body: RawHtml): string {
  // `<!doctype html>` and an explicit charset so the file renders the same from disk as from a
  // server; nothing else is loaded, so there is nothing else to get wrong.
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${STYLE}</style>
</head>
<body>
${body.value}
</body>
</html>
`;
}

/** Optional extras a caller already computed. Nothing here is derived by the renderer. */
export interface HtmlReportOptions {
  /** Rendered as a panel when given. Absent means no index was computed, and none is shown. */
  readonly riskIndex?: RiskIndexReport;
}

export function toHtml(report: FairUxReport, options: HtmlReportOptions = {}): string {
  const body = html`<h1>FairUX report</h1>
<p class="disclaimer">${DISCLAIMER}</p>
<ul class="meta">${summaryItems(report)}</ul>
${riskIndexPanel(options.riskIndex)}
${coveragePanel(report.coverage, "Coverage")}
${
  report.findings.length === 0
    ? html`<p class="empty">No findings. This is not a statement that the page is fair or compliant — only that these rules matched nothing.</p>`
    : html`${severityGroups(report.findings)}`
}
${suppressionPanel(report)}
${externalFilterPanel(report)}`;
  return document("FairUX report", body);
}

export function toBatchHtml(report: FairUxBatchReport, options: HtmlReportOptions = {}): string {
  const files = report.reports.map((subReport, index) => {
    const input = report.inputs[index];
    return html`<section>
<h2>${input?.file ?? `input ${index + 1}`}</h2>
${coveragePanel(subReport.coverage, "Coverage for this input")}
${
  subReport.findings.length === 0
    ? html`<p class="empty">No findings.</p>`
    : html`${severityGroups(subReport.findings)}`
}
${suppressionPanel(subReport)}
</section>`;
  });

  const body = html`<h1>FairUX report</h1>
<p class="disclaimer">${DISCLAIMER}</p>
<ul class="meta">${summaryItems(report)}</ul>
${riskIndexPanel(options.riskIndex)}
${
  report.summary.total === 0
    ? html`<p class="empty">No findings. This is not a statement that these pages are fair or compliant — only that these rules matched nothing.</p>`
    : raw("")
}
${files}
${externalFilterPanel(report)}`;
  return document("FairUX report", body);
}
