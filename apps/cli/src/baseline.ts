import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { FairUxBatchReport, FairUxReport, Finding } from "@fairux/core";
import { writeArtifact } from "./artifact-write.js";

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

export function writeBaseline(filePath: string, baseline: BaselineFile): void {
  writeArtifact(resolve(filePath), serializeBaseline(baseline));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Whether a string is an ISO 8601 date-time a reader can trust.
 *
 * Deliberately not "whatever `Date.parse` accepts": that swallows `"December 17, 1995"` and, in some
 * runtimes, `"2026"` — neither of which is what a `createdAt` written by this tool looks like, and a
 * baseline's date is the only thing in the file that says how old the accepted risk is.
 *
 * Also deliberately not `toISOString()`'s exact output. A v1 file may have been written by an older
 * version, edited by a human, or produced by a script that omits the milliseconds or uses an offset
 * rather than `Z`; all of those are real instants and stay readable.
 */
function isIsoDateTime(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(value)) return false;
  return Number.isFinite(Date.parse(value));
}

/**
 * Read a version-1 baseline, refusing anything downstream would then misread.
 *
 * The whole consumed shape is checked, not only what `applyBaseline` dereferences. A baseline is
 * committed and read back a year later by whoever inherited it, and every field here is part of the
 * answer to "what is this file and can I still believe it": `note` says what a baseline is,
 * `toolVersion` and `createdAt` say what wrote it and when. A file missing them is not a v1 file
 * this tool wrote, and reading it as one hides that.
 *
 * Two things it deliberately does **not** do. It does not compare `note` to the current generator
 * prose — that sentence is allowed to be reworded, and a check on its text would make every valid
 * older baseline unreadable. And it does not reject unknown fields: a file written by a later
 * version stays readable by this one, and the fields this version consumes are the ones checked.
 */
export function parseBaseline(contents: string, filePath: string): BaselineFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch (error) {
    throw new BaselineError(
      `baseline "${filePath}" is not valid JSON: ${(error as Error).message}`,
    );
  }
  if (!isPlainObject(parsed)) {
    throw new BaselineError(
      `baseline "${filePath}" is not an object — expected a baseline file, ` +
        `found ${Array.isArray(parsed) ? "an array" : typeof parsed}`,
    );
  }
  const record = parsed as Partial<BaselineFile>;
  if (record.schemaVersion !== BASELINE_SCHEMA_VERSION) {
    throw new BaselineError(
      `baseline "${filePath}" has schemaVersion ${JSON.stringify(record.schemaVersion)}, ` +
        `expected "${BASELINE_SCHEMA_VERSION}"`,
    );
  }
  if (typeof record.note !== "string" || record.note.trim() === "") {
    throw new BaselineError(
      `baseline "${filePath}" has no note — a v1 baseline carries the sentence saying what it is, ` +
        "for whoever finds it later",
    );
  }
  if (typeof record.toolVersion !== "string" || record.toolVersion.trim() === "") {
    throw new BaselineError(`baseline "${filePath}" has no toolVersion`);
  }
  if (typeof record.createdAt !== "string" || !isIsoDateTime(record.createdAt)) {
    throw new BaselineError(
      `baseline "${filePath}" has createdAt ${JSON.stringify(record.createdAt)}, ` +
        "expected an ISO 8601 date-time",
    );
  }
  if (!Array.isArray(record.entries)) {
    throw new BaselineError(`baseline "${filePath}" has no entries array`);
  }

  // Where each fingerprint was first seen, so a duplicate can name both indexes. `createBaseline`
  // never writes one — a duplicate means the file was edited or merged, and a file whose entry
  // count disagrees with the number of findings it accepts is one nobody can audit against a scan.
  const firstSeen = new Map<string, number>();

  record.entries.forEach((entry: unknown, index) => {
    const at = `baseline "${filePath}" entry ${index}`;
    if (!isPlainObject(entry)) {
      throw new BaselineError(
        `${at} is not an object — found ${entry === null ? "null" : typeof entry}`,
      );
    }
    if (typeof entry.fingerprint !== "string" || entry.fingerprint === "") {
      throw new BaselineError(`baseline "${filePath}" has an entry with no fingerprint (${at})`);
    }
    const fingerprint = entry.fingerprint;
    if (typeof entry.ruleId !== "string" || entry.ruleId === "") {
      // Recorded for a human, never matched on — and the stale-entry report names it, so an entry
      // without one is an entry a reader cannot act on.
      throw new BaselineError(`${at} (${fingerprint}) has no ruleId`);
    }
    if (entry.file !== undefined && (typeof entry.file !== "string" || entry.file === "")) {
      throw new BaselineError(
        `${at} (${fingerprint}) has file ${JSON.stringify(entry.file)}, ` +
          "expected a non-empty string",
      );
    }
    const previous = firstSeen.get(fingerprint);
    if (previous !== undefined) {
      throw new BaselineError(
        `baseline "${filePath}" has ${fingerprint} twice, at entry ${previous} and entry ${index}`,
      );
    }
    firstSeen.set(fingerprint, index);
  });

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
  /**
   * Baselined entries absent from the report used for the liveness check, so the file can shrink.
   *
   * Absent from that report, which is not the same as gone: it cannot account for findings removed
   * inside the scanner by an inline directive, because those leave no fingerprint behind.
   */
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
 *
 * `beforeFileFilters` is a separate argument because a caller may hand this function a report that
 * another file-driven filter has already subtracted from. "Gone" and "hidden by that filter" are
 * then two different things, and only the first is a reason to delete a baseline entry: a finding
 * still present before those filters ran is hidden, not gone, and an entry covering it has not
 * become stale. It defaults to `report`, which is correct whenever nothing ran before this. It must
 * be the same shape as `report` — a batch's fingerprints answer nothing about a single document.
 *
 * It is **not** a reconstruction of everything the scanner found. Inline suppression directives are
 * applied inside `scan()` and record only a rule, a reason, and a line, so a finding one of them
 * removed carries no fingerprint anywhere in the report and cannot be matched here. An entry
 * covering such a finding is still reported as stale. That is a limitation of what the report
 * carries, unchanged by this argument and not fixed by it.
 */
export function applyBaseline<T extends FairUxReport | FairUxBatchReport>(
  report: T,
  baseline: BaselineFile,
  beforeFileFilters: NoInfer<T> = report,
): BaselineApplication<T> {
  const baselined = new Set(baseline.entries.map((entry) => entry.fingerprint));
  const present = new Set(findingsOf(beforeFileFilters).map((finding) => finding.fingerprint));
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
