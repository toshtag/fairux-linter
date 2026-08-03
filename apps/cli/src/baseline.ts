import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { FairUxBatchReport, FairUxReport, Finding } from "@fairux/core";
import { type ArtifactSnapshot, replaceArtifact } from "./file-replace.js";

/**
 * Baselines — adopting the linter on a codebase that already has findings.
 *
 * **A baseline is a record of accepted risk, not of resolved risk.** Nothing about writing one makes
 * a finding less true, and nothing here presents a baselined run as clean: every report says how
 * many findings the baseline suppressed, and the file itself carries the same sentence for whoever
 * reads it in a year.
 *
 * Keyed on `fingerprints.fairuxV1`, which is the identity FairUX owns and documents for exactly this
 * — consumers building their own matching. Its limitation is real and is stated rather than
 * discovered: the primary locator is part of the fingerprint, so restructuring the markup around a
 * finding changes it and the finding reads as new. A green build turning red for a change nobody
 * thinks touched anything is the failure mode, and it is a property of the fingerprint rather than
 * of this file.
 */

/** Current baseline file shape. Versioned, because a baseline outlives the run that wrote it. */
export const BASELINE_SCHEMA_VERSION = "1" as const;

export interface BaselineEntry {
  readonly fingerprint: string;
  /** Recorded for a human reading the file; matching is on the fingerprint alone. */
  readonly ruleId: string;
  readonly file?: string;
}

export interface BaselineFile {
  readonly schemaVersion: typeof BASELINE_SCHEMA_VERSION;
  /** What this file is, in the file, for whoever finds it later. */
  readonly note: string;
  readonly toolVersion: string;
  readonly createdAt: string;
  readonly entries: readonly BaselineEntry[];
}

const BASELINE_NOTE =
  "Accepted risk, not resolved risk. Every finding recorded here is still present and still true; " +
  "this file only stops it failing a build. Findings are matched by fingerprint, which changes when " +
  "the markup around a finding is restructured — such a finding will reappear as new.";

export class BaselineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BaselineError";
  }
}

function findingsOf(report: FairUxReport | FairUxBatchReport): readonly Finding[] {
  return "reports" in report
    ? report.reports.flatMap((subReport) => subReport.findings)
    : report.findings;
}

/**
 * Build a baseline from a report.
 *
 * Entries are sorted by fingerprint so the file is stable across runs: a baseline is committed, and
 * one that reordered itself would produce a diff on every write.
 */
export function createBaseline(
  report: FairUxReport | FairUxBatchReport,
  options: { toolVersion: string; now?: () => Date },
): BaselineFile {
  const now = options.now ?? (() => new Date());
  const seen = new Map<string, BaselineEntry>();
  for (const finding of findingsOf(report)) {
    // One entry per fingerprint. Two findings sharing one are the same accepted risk, and two
    // entries would make the resolved-count arithmetic below wrong.
    if (!seen.has(finding.fingerprint)) {
      seen.set(finding.fingerprint, {
        fingerprint: finding.fingerprint,
        ruleId: finding.ruleId,
        ...(finding.evidence[0]?.source?.file ? { file: finding.evidence[0].source.file } : {}),
      });
    }
  }

  return {
    schemaVersion: BASELINE_SCHEMA_VERSION,
    note: BASELINE_NOTE,
    toolVersion: options.toolVersion,
    createdAt: now().toISOString(),
    entries: [...seen.values()].sort((a, b) => a.fingerprint.localeCompare(b.fingerprint)),
  };
}

function serializeBaseline(baseline: BaselineFile): string {
  return `${JSON.stringify(baseline, null, 2)}\n`;
}

export function writeBaseline(
  filePath: string,
  baseline: BaselineFile,
  expected?: ArtifactSnapshot,
): void {
  replaceArtifact(resolve(filePath), serializeBaseline(baseline), undefined, expected);
}

export function parseBaseline(contents: string, filePath: string): BaselineFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch (error) {
    throw new BaselineError(
      `baseline "${filePath}" is not valid JSON: ${(error as Error).message}`,
    );
  }
  const record = parsed as Partial<BaselineFile>;
  if (record?.schemaVersion !== BASELINE_SCHEMA_VERSION) {
    throw new BaselineError(
      `baseline "${filePath}" has schemaVersion ${JSON.stringify(record?.schemaVersion)}, ` +
        `expected "${BASELINE_SCHEMA_VERSION}"`,
    );
  }
  if (!Array.isArray(record.entries)) {
    throw new BaselineError(`baseline "${filePath}" has no entries array`);
  }
  for (const entry of record.entries) {
    if (typeof entry?.fingerprint !== "string" || entry.fingerprint === "") {
      throw new BaselineError(`baseline "${filePath}" has an entry with no fingerprint`);
    }
  }
  return record as BaselineFile;
}

export function readBaseline(filePath: string): BaselineFile {
  const abs = isAbsolute(filePath) ? filePath : resolve(filePath);
  if (!existsSync(abs) || !statSync(abs).isFile()) {
    throw new BaselineError(`baseline file not found: ${abs}`);
  }
  return parseBaseline(readFileSync(abs, "utf8"), abs);
}

export interface BaselineApplication<T> {
  readonly report: T;
  /** How many findings the baseline hid. Reported, never silent. */
  readonly suppressed: number;
  /** Baselined fingerprints that no longer appear, so the file can shrink. */
  readonly resolved: readonly BaselineEntry[];
}

function subtract(findings: readonly Finding[], baselined: ReadonlySet<string>): Finding[] {
  return findings.filter((finding) => !baselined.has(finding.fingerprint));
}

function recount(findings: readonly Finding[]): FairUxReport["summary"] {
  const bySeverity = { info: 0, low: 0, medium: 0, high: 0 };
  for (const finding of findings) bySeverity[finding.severity] += 1;
  return { total: findings.length, bySeverity };
}

/**
 * Remove baselined findings from a report, and say what happened.
 *
 * The summary is recomputed rather than left alone: a report whose `summary.total` disagreed with
 * its own `findings` array is a report no consumer can trust, and `--fail-on` reads the same
 * subtracted report so the two cannot diverge.
 */
export function applyBaseline<T extends FairUxReport | FairUxBatchReport>(
  report: T,
  baseline: BaselineFile,
): BaselineApplication<T> {
  const baselined = new Set(baseline.entries.map((entry) => entry.fingerprint));
  const present = new Set(findingsOf(report).map((finding) => finding.fingerprint));
  const resolved = baseline.entries.filter((entry) => !present.has(entry.fingerprint));
  const before = findingsOf(report).length;

  if ("reports" in report) {
    const reports = report.reports.map((subReport) => {
      const findings = subtract(subReport.findings, baselined);
      return { ...subReport, findings, summary: recount(findings) };
    });
    const all = reports.flatMap((subReport) => subReport.findings);
    return {
      report: { ...report, reports, summary: recount(all) } as T,
      suppressed: before - all.length,
      resolved,
    };
  }

  const findings = subtract(report.findings, baselined);
  return {
    report: { ...report, findings, summary: recount(findings) } as T,
    suppressed: before - findings.length,
    resolved,
  };
}

/**
 * What a baselined run must say on stderr.
 *
 * Always, even when nothing was suppressed. A run that hid twelve findings and said nothing would be
 * worse than having no baseline at all, and a reader cannot tell "the baseline is empty" from "the
 * baseline was not applied" unless both are reported.
 */
export function describeBaselineApplication(
  application: BaselineApplication<unknown>,
  filePath: string,
): string {
  const lines = [
    `fairux: baseline "${filePath}" suppressed ${application.suppressed} finding(s) — ` +
      "accepted risk, not resolved risk",
  ];
  if (application.resolved.length > 0) {
    lines.push(
      `fairux: ${application.resolved.length} baselined finding(s) no longer appear; ` +
        "rewrite the baseline to drop them",
    );
  }
  return `${lines.join("\n")}\n`;
}
