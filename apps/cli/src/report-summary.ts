import type { FairUxBatchReport, FairUxReport, Finding, Runtime, Severity } from "@fairux/core";

/**
 * Recomputing a summary after a filter has removed findings.
 *
 * `--suppress` and `--baseline` both subtract, and both have to leave a report whose summary agrees
 * with its own findings — a report where the two disagree is one no consumer can trust, and
 * `--fail-on` reads the subtracted report so the threshold and the output cannot diverge.
 *
 * It lives here because both filters need it and both had their own copy. The copies were identical
 * and both wrong in the same way: they returned `{ total, bySeverity }`, which is the whole of a
 * single report's summary and **not** the whole of a batch's. A batch also carries `byRuntime`, so
 * `fairux scan . --format json` reported a per-runtime breakdown and
 * `fairux scan . --format json --suppress s.json` did not — a field that vanishes when a filter is
 * passed, in the report a pipeline reads.
 *
 * A finding does not know its own runtime, so the per-runtime split is computed from the sub-reports
 * rather than from the flattened list. That is also why this cannot be a one-line change inside
 * either filter.
 */

function emptyBySeverity(): Record<Severity, number> {
  return { info: 0, low: 0, medium: 0, high: 0 };
}

/** The summary a single report carries: what is left, counted by severity. */
export function recountSummary(findings: readonly Finding[]): FairUxReport["summary"] {
  const bySeverity = emptyBySeverity();
  for (const finding of findings) bySeverity[finding.severity] += 1;
  return { total: findings.length, bySeverity };
}

/**
 * The summary a batch carries, including the per-runtime split when the report had one.
 *
 * `previous` decides whether `byRuntime` is emitted at all. A batch this CLI built always has it; a
 * report built before it existed does not, and a filter is not the place to start adding fields a
 * caller never asked for.
 */
export function recountBatchSummary(
  reports: FairUxBatchReport["reports"],
  previous: FairUxBatchReport["summary"],
): FairUxBatchReport["summary"] {
  const all = reports.flatMap((report) => report.findings);
  const summary = recountSummary(all);
  if (previous.byRuntime === undefined) return summary;

  // Every runtime the batch started with, including the ones a filter emptied. A runtime that drops
  // out of the map reads as "this batch had no Figma input", which is a different statement from
  // "every Figma finding was accepted", and the second is what happened.
  const byRuntime: Record<string, { total: number; bySeverity: Record<Severity, number> }> = {};
  for (const runtime of Object.keys(previous.byRuntime)) {
    byRuntime[runtime] = { total: 0, bySeverity: emptyBySeverity() };
  }
  for (const report of reports) {
    const runtime: Runtime = report.input.runtime;
    byRuntime[runtime] ??= { total: 0, bySeverity: emptyBySeverity() };
    const entry = byRuntime[runtime];
    entry.total += report.findings.length;
    for (const finding of report.findings) entry.bySeverity[finding.severity] += 1;
  }
  return { ...summary, byRuntime: byRuntime as FairUxBatchReport["summary"]["byRuntime"] };
}
