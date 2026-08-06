import type {
  ExternalFilterEntry,
  ExternalFilterRecord,
  FairUxBatchReport,
  FairUxReport,
} from "@fairux/core";
import type { BaselineApplication, BaselineEntry, BaselineFile } from "./baseline.js";
import { recountSummary } from "./report-summary.js";
import type { SuppressionApplication, SuppressionEntry, SuppressionsFile } from "./suppressions.js";

/**
 * Putting a filter file's accounting into the report it filtered.
 *
 * Both `--suppress` and `--baseline` already account for every entry — which applied, which lapsed,
 * which matched nothing, which is stale. Both wrote that to stderr, and stderr is the one place a
 * stored artifact does not keep. What survives a CI run is the JSON a step uploaded, the SARIF a
 * code-scanning tab ingested, and the HTML somebody attached to a ticket. All three showed a short
 * list of findings and none of them said a file had made it short.
 *
 * The record is built from the application rather than recomputed, so the report cannot disagree
 * with the run: the same counts that produced the stderr summary produce this.
 */

type Report = FairUxReport | FairUxBatchReport;

function findingsOf(report: Report) {
  return "reports" in report
    ? report.reports.flatMap((subReport) => subReport.findings)
    : report.findings;
}

/** The `{ total, bySeverity }` pair, whichever shape of report it came from. */
export function countOf(report: Report): ExternalFilterRecord["detected"] {
  return recountSummary(findingsOf(report));
}

function suppressionEntry(entry: SuppressionEntry, count?: number): ExternalFilterEntry {
  return {
    fingerprint: entry.fingerprint,
    ...(entry.ruleId ? { ruleId: entry.ruleId } : {}),
    reason: entry.reason,
    ...(entry.expiresOn ? { expiresOn: entry.expiresOn } : {}),
    ...(count === undefined ? {} : { count }),
  };
}

function baselineEntry(entry: BaselineEntry, count?: number): ExternalFilterEntry {
  // No `reason`: a baseline has nowhere to put one, and inventing an empty string here would make
  // a baseline look like an argued suppression to anything reading the two through one shape.
  return {
    fingerprint: entry.fingerprint,
    ...(entry.ruleId ? { ruleId: entry.ruleId } : {}),
    ...(count === undefined ? {} : { count }),
  };
}

/** Omitted rather than empty, so `expired: []` never has to be told from "none expired". */
function optional(entries: readonly ExternalFilterEntry[]) {
  return entries.length > 0 ? entries : undefined;
}

export function suppressionFilterRecord(
  application: SuppressionApplication<Report>,
  suppressions: SuppressionsFile,
  file: string,
  digest: string,
  detected: ExternalFilterRecord["detected"],
): ExternalFilterRecord {
  const expired = application.expired.map((entry) => suppressionEntry(entry));
  const unmatched = application.unmatched.map((entry) => suppressionEntry(entry));
  return {
    kind: "suppressions",
    file,
    digest,
    // Only a schema version: a suppressions file records nothing else about itself. `identity` holds
    // what the file states, not what a reader might wish it stated.
    identity: { schemaVersion: suppressions.schemaVersion },
    detected,
    reported: countOf(application.report),
    applied: application.applied.map(({ entry, count }) => suppressionEntry(entry, count)),
    ...(optional(expired) ? { expired } : {}),
    ...(optional(unmatched) ? { unmatched } : {}),
  };
}

export function baselineFilterRecord(
  application: BaselineApplication<Report>,
  baseline: BaselineFile,
  file: string,
  digest: string,
  detected: ExternalFilterRecord["detected"],
): ExternalFilterRecord {
  const resolved = application.resolved.map((entry) => baselineEntry(entry));
  return {
    kind: "baseline",
    file,
    digest,
    // A baseline says what wrote it and when. Both are what a reader needs to tell "this file is a
    // year old and nobody has looked at it" from "this file was rewritten last week".
    identity: {
      schemaVersion: baseline.schemaVersion,
      toolVersion: baseline.toolVersion,
      createdAt: baseline.createdAt,
    },
    detected,
    reported: countOf(application.report),
    applied: application.applied.map(({ entry, count }) => baselineEntry(entry, count)),
    ...(optional(resolved) ? { resolved } : {}),
  };
}

/**
 * Attach the records to the report, or leave the report alone.
 *
 * Absent, never empty: a report with no `externalFilters` had no filter file, which is a claim the
 * field is there to be able to make.
 */
export function withExternalFilters<T extends Report>(
  report: T,
  records: readonly ExternalFilterRecord[],
): T {
  if (records.length === 0) return report;
  return { ...report, externalFilters: records } as T;
}
