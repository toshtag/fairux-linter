import type { Evidence, FairUxBatchReport, FairUxReport, Finding, Severity } from "@fairux/core";
import { DISCLAIMER } from "./disclaimer.js";

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

export function toHtml(report: FairUxReport): string {
  const body = html`<h1>FairUX report</h1>
<p class="disclaimer">${DISCLAIMER}</p>
<ul class="meta">${summaryItems(report)}</ul>
${
  report.findings.length === 0
    ? html`<p class="empty">No findings. This is not a statement that the page is fair or compliant — only that these rules matched nothing.</p>`
    : html`${severityGroups(report.findings)}`
}`;
  return document("FairUX report", body);
}

export function toBatchHtml(report: FairUxBatchReport): string {
  const files = report.reports.map((subReport, index) => {
    const input = report.inputs[index];
    return html`<section>
<h2>${input?.file ?? `input ${index + 1}`}</h2>
${
  subReport.findings.length === 0
    ? html`<p class="empty">No findings.</p>`
    : html`${severityGroups(subReport.findings)}`
}
</section>`;
  });

  const body = html`<h1>FairUX report</h1>
<p class="disclaimer">${DISCLAIMER}</p>
<ul class="meta">${summaryItems(report)}</ul>
${
  report.summary.total === 0
    ? html`<p class="empty">No findings. This is not a statement that these pages are fair or compliant — only that these rules matched nothing.</p>`
    : html`${files}`
}`;
  return document("FairUX report", body);
}
