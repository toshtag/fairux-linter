import type {
  FairUxBatchReport,
  FairUxInputReport,
  FairUxReport,
  Finding,
  Runtime,
  Severity,
} from "@fairux/core";

/**
 * Valid reports, built rather than asserted into existence.
 *
 * The filter tests used to write a partial object literal and push it through
 * `as unknown as FairUxBatchReport`. That cast is not a shortcut with a small cost — it turns off
 * the only check that the fixture resembles what the code under test will actually receive. Two
 * things followed from it here:
 *
 * - the fixtures carried `inputs: [{ file: "a.html" }]` with no `runtime`, which is not a valid
 *   input, so no test could have noticed that a batch filter was dropping `summary.byRuntime` —
 *   there was no runtime in the fixture to drop;
 * - `reports[]` entries carried four fields, mirroring the code's own defect rather than the
 *   contract, so the fixture agreed with the bug.
 *
 * Everything here is typed. A field the schema adds tomorrow either has a default here or breaks
 * this file, which is the point: a fixture that cannot go stale silently.
 */

const SEVERITIES: readonly Severity[] = ["info", "low", "medium", "high"];

function emptyBySeverity(): Record<Severity, number> {
  return { info: 0, low: 0, medium: 0, high: 0 };
}

function countBySeverity(findings: readonly Finding[]): Record<Severity, number> {
  const counts = emptyBySeverity();
  for (const finding of findings) counts[finding.severity] += 1;
  return counts;
}

export interface FindingSpec {
  readonly fingerprint: string;
  readonly severity?: Severity;
  readonly ruleId?: string;
}

/** One finding, complete enough to be a `Finding` rather than a cast. */
export function finding(spec: FindingSpec | string): Finding {
  const {
    fingerprint,
    severity = "medium",
    ruleId = "scarcity/scarcity-phrase",
  } = typeof spec === "string" ? { fingerprint: spec } : spec;
  return {
    id: `${ruleId}#${fingerprint}`,
    fingerprint,
    ruleId,
    category: "scarcity",
    severity,
    confidence: "medium",
    title: "Scarcity or urgency phrasing",
    description: `A finding fingerprinted ${fingerprint}.`,
    whyItMatters: "Unverified scarcity can pressure users into rushed decisions.",
    recommendation: "Use scarcity claims only when backed by real, current data.",
    evidence: [{ locator: { type: "css", value: "main > p" }, text: "Only 2 left!" }],
  } satisfies Finding;
}

export interface InputReportSpec {
  readonly file?: string;
  readonly runtime?: Runtime;
  readonly figmaFile?: string;
  readonly findings?: readonly (FindingSpec | string)[];
  readonly suppressed?: FairUxInputReport["suppressed"];
  readonly suppressionDiagnostics?: FairUxInputReport["suppressionDiagnostics"];
}

/** One per-input report — the shape a batch entry and a single report both carry. */
export function inputReport(spec: InputReportSpec = {}): FairUxInputReport {
  const findings = (spec.findings ?? []).map(finding);
  return {
    input: {
      ...(spec.file === undefined ? {} : { file: spec.file }),
      runtime: spec.runtime ?? "html",
      ...(spec.figmaFile === undefined ? {} : { figmaFile: spec.figmaFile }),
    },
    summary: { total: findings.length, bySeverity: countBySeverity(findings) },
    findings,
    ...(spec.suppressed ? { suppressed: spec.suppressed } : {}),
    ...(spec.suppressionDiagnostics ? { suppressionDiagnostics: spec.suppressionDiagnostics } : {}),
  } satisfies FairUxInputReport;
}

export function singleReport(spec: InputReportSpec = {}): FairUxReport {
  return {
    kind: "single",
    schemaVersion: "0.1",
    toolVersion: "test",
    generatedAt: "2026-01-01T00:00:00.000Z",
    ...inputReport(spec),
  } satisfies FairUxReport;
}

/**
 * A batch whose `summary` is computed from its inputs, `byRuntime` included.
 *
 * Computed rather than written out, so a fixture cannot disagree with itself — and so `byRuntime` is
 * present on every batch fixture, which is what makes a filter that drops it observable.
 */
export function batchReport(specs: readonly InputReportSpec[]): FairUxBatchReport {
  const reports = specs.map(inputReport);
  const all = reports.flatMap((report) => report.findings);
  const byRuntime: Record<string, { total: number; bySeverity: Record<Severity, number> }> = {};
  for (const report of reports) {
    const runtime = report.input.runtime;
    byRuntime[runtime] ??= { total: 0, bySeverity: emptyBySeverity() };
    const entry = byRuntime[runtime];
    entry.total += report.findings.length;
    for (const found of report.findings) entry.bySeverity[found.severity] += 1;
  }
  return {
    kind: "batch",
    schemaVersion: "0.1",
    toolVersion: "test",
    generatedAt: "2026-01-01T00:00:00.000Z",
    inputs: reports.map((report) => report.input),
    summary: {
      total: all.length,
      bySeverity: countBySeverity(all),
      byRuntime: byRuntime as FairUxBatchReport["summary"]["byRuntime"],
    },
    reports,
  } satisfies FairUxBatchReport;
}

/** Every severity, so a test asserting a breakdown has something to break. */
export const ALL_SEVERITIES = SEVERITIES;
