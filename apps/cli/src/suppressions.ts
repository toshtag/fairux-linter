import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { FairUxBatchReport, FairUxReport, Finding } from "@fairux/core";

/**
 * Suppressions — one finding, one argument, optionally with an end date.
 *
 * Deliberately not a second baseline. A baseline says "all of this is accepted, as of a date"; it
 * cannot say why any one finding is accepted and it cannot expire. A suppression is the other
 * shape: individual, argued, and allowed to lapse.
 *
 * **A reason is required and may not be blank.** A suppression whose reason is `""` is a disabled
 * rule with extra steps, and the argument is the entire point of the feature — so a file containing
 * one is refused before anything is scanned rather than applied and hoped about.
 *
 * Neither this nor a baseline makes a finding untrue. Every run reports what was suppressed and why,
 * because a suppression nobody can see is a rule that was silently turned off.
 */

export const SUPPRESSIONS_SCHEMA_VERSION = "1" as const;

export interface SuppressionEntry {
  /** `fingerprints.fairuxV1` of the finding being suppressed. */
  readonly fingerprint: string;
  /** Why this finding is accepted here. Required, non-empty. */
  readonly reason: string;
  /** Recorded for a human reading the file; matching is on the fingerprint alone. */
  readonly ruleId?: string;
  /** `YYYY-MM-DD`. After this date the suppression stops applying and says so. */
  readonly expiresOn?: string;
}

export interface SuppressionsFile {
  readonly schemaVersion: typeof SUPPRESSIONS_SCHEMA_VERSION;
  readonly entries: readonly SuppressionEntry[];
}

export class SuppressionsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SuppressionsError";
  }
}

function findingsOf(report: FairUxReport | FairUxBatchReport): readonly Finding[] {
  return "reports" in report
    ? report.reports.flatMap((subReport) => subReport.findings)
    : report.findings;
}

export function parseSuppressions(contents: string, filePath: string): SuppressionsFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch (error) {
    throw new SuppressionsError(
      `suppressions "${filePath}" is not valid JSON: ${(error as Error).message}`,
    );
  }
  const record = parsed as Partial<SuppressionsFile>;
  if (record?.schemaVersion !== SUPPRESSIONS_SCHEMA_VERSION) {
    throw new SuppressionsError(
      `suppressions "${filePath}" has schemaVersion ${JSON.stringify(record?.schemaVersion)}, ` +
        `expected "${SUPPRESSIONS_SCHEMA_VERSION}"`,
    );
  }
  if (!Array.isArray(record.entries)) {
    throw new SuppressionsError(`suppressions "${filePath}" has no entries array`);
  }

  record.entries.forEach((entry, index) => {
    const at = `suppressions "${filePath}" entry ${index}`;
    if (typeof entry?.fingerprint !== "string" || entry.fingerprint === "") {
      throw new SuppressionsError(`${at} has no fingerprint`);
    }
    // The refusal this file exists for. Whitespace does not count as an argument.
    if (typeof entry.reason !== "string" || entry.reason.trim() === "") {
      throw new SuppressionsError(
        `${at} (${entry.fingerprint}) has no reason — a suppression without one is a disabled rule ` +
          "with extra steps",
      );
    }
    if (entry.expiresOn !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(entry.expiresOn)) {
      throw new SuppressionsError(
        `${at} (${entry.fingerprint}) has expiresOn ${JSON.stringify(entry.expiresOn)}, ` +
          "expected YYYY-MM-DD",
      );
    }
  });

  return record as SuppressionsFile;
}

export function readSuppressions(filePath: string): SuppressionsFile {
  const abs = isAbsolute(filePath) ? filePath : resolve(filePath);
  if (!existsSync(abs) || !statSync(abs).isFile()) {
    throw new SuppressionsError(`suppressions file not found: ${abs}`);
  }
  return parseSuppressions(readFileSync(abs, "utf8"), abs);
}

/**
 * Whether an entry has lapsed.
 *
 * Compared as `YYYY-MM-DD` strings, which sort correctly and avoid asking what timezone a
 * suppression expires in — a question with no good answer for a date somebody typed into a file.
 * The suppression applies through the whole of its `expiresOn` day.
 */
export function isExpired(entry: SuppressionEntry, today: string): boolean {
  return entry.expiresOn !== undefined && entry.expiresOn < today;
}

export interface SuppressionApplication<T> {
  readonly report: T;
  /** Entries that removed at least one finding, with what they removed. */
  readonly applied: readonly { readonly entry: SuppressionEntry; readonly count: number }[];
  /** Entries past their date. Their findings are reported, and so is the lapse. */
  readonly expired: readonly SuppressionEntry[];
  /** Entries matching nothing present — a suppression nobody will otherwise remove. */
  readonly unmatched: readonly SuppressionEntry[];
}

function recount(findings: readonly Finding[]): FairUxReport["summary"] {
  const bySeverity = { info: 0, low: 0, medium: 0, high: 0 };
  for (const finding of findings) bySeverity[finding.severity] += 1;
  return { total: findings.length, bySeverity };
}

/**
 * Remove suppressed findings, and account for every entry.
 *
 * `today` is passed in rather than read here so the expiry boundary is testable without moving a
 * clock, which is the same reason `scan()` takes a `now`.
 */
export function applySuppressions<T extends FairUxReport | FairUxBatchReport>(
  report: T,
  suppressions: SuppressionsFile,
  today: string,
): SuppressionApplication<T> {
  const active = suppressions.entries.filter((entry) => !isExpired(entry, today));
  const expired = suppressions.entries.filter((entry) => isExpired(entry, today));
  const byFingerprint = new Map(active.map((entry) => [entry.fingerprint, entry]));

  const counts = new Map<string, number>();
  const keep = (finding: Finding): boolean => {
    const entry = byFingerprint.get(finding.fingerprint);
    if (!entry) return true;
    counts.set(entry.fingerprint, (counts.get(entry.fingerprint) ?? 0) + 1);
    return false;
  };

  const present = new Set(findingsOf(report).map((finding) => finding.fingerprint));
  // Expired entries are not "unmatched": they matched nothing because they stopped applying, which
  // is a different thing to tell the user about and is reported separately.
  const unmatched = active.filter((entry) => !present.has(entry.fingerprint));

  const applied = () =>
    active
      .filter((entry) => (counts.get(entry.fingerprint) ?? 0) > 0)
      .map((entry) => ({ entry, count: counts.get(entry.fingerprint) ?? 0 }));

  if ("reports" in report) {
    const reports = report.reports.map((subReport) => {
      const findings = subReport.findings.filter(keep);
      return { ...subReport, findings, summary: recount(findings) };
    });
    const all = reports.flatMap((subReport) => subReport.findings);
    return {
      report: { ...report, reports, summary: recount(all) } as T,
      applied: applied(),
      expired,
      unmatched,
    };
  }

  const findings = report.findings.filter(keep);
  return {
    report: { ...report, findings, summary: recount(findings) } as T,
    applied: applied(),
    expired,
    unmatched,
  };
}

/**
 * What a suppressed run must say on stderr.
 *
 * The reason is printed, not just the count. A suppression nobody can see is a rule that was
 * silently turned off, and the argument is the only thing distinguishing the two.
 */
export function describeSuppressionApplication(
  application: SuppressionApplication<unknown>,
  filePath: string,
): string {
  const total = application.applied.reduce((sum, entry) => sum + entry.count, 0);
  const lines = [`fairux: suppressions "${filePath}" removed ${total} finding(s):`];
  for (const { entry, count } of application.applied) {
    lines.push(
      `fairux:   ${entry.ruleId ?? entry.fingerprint} ×${count} — ${entry.reason}` +
        (entry.expiresOn ? ` (expires ${entry.expiresOn})` : ""),
    );
  }
  for (const entry of application.expired) {
    lines.push(
      `fairux:   EXPIRED ${entry.expiresOn}: ${entry.ruleId ?? entry.fingerprint} — ` +
        `no longer suppressing (${entry.reason})`,
    );
  }
  for (const entry of application.unmatched) {
    lines.push(
      `fairux:   unused: ${entry.ruleId ?? entry.fingerprint} matched no finding — remove it`,
    );
  }
  return `${lines.join("\n")}\n`;
}
