import { createHash } from "node:crypto";
import { closeSync, fstatSync, openSync, readSync, realpathSync } from "node:fs";
import { extname, isAbsolute, relative, resolve, sep } from "node:path";
import { parseSource } from "@fairux/ast";
import {
  createScanner,
  type FairUxBatchReport,
  type FairUxReport,
  type FairuxConfig,
  type FairuxScanner,
  type Finding,
  InputTooLargeError,
  type JourneyReport,
  type JourneyStep,
  MAX_INPUT_BYTES,
  type RuleMeta,
  type RulePack,
  type Severity,
  type UiDocument,
} from "@fairux/core";
import { parseFigma } from "@fairux/figma";
import { parseHtml } from "@fairux/html";
import type { HtmlReportOptions } from "@fairux/report";
import {
  toBatchHtml,
  toBatchMarkdown,
  toBatchSarif,
  toHtml,
  toJson,
  toMarkdown,
  toSarif,
} from "@fairux/report";
import { fairuxBuiltinRulePack } from "@fairux/rules";

export type OutputFormat = "json" | "markdown" | "sarif" | "html";
export type BatchLimitKind = "files" | "findings";

export class BatchLimitError extends Error {
  constructor(
    public readonly limit: number,
    public readonly actual: number,
    public readonly kind: BatchLimitKind,
  ) {
    super(`batch exceeds ${kind} limit (${actual} ${kind} > ${limit} ${kind}).`);
    this.name = "BatchLimitError";
  }
}

export interface BoundedFileContents {
  source: string;
  byteLength: number;
}

export interface ScanFileOptions {
  format: OutputFormat;
  /** Explicit CLI flag wins over `config.includeExperimental` when set. */
  includeExperimental?: boolean;
  toolVersion?: string;
  /** Injectable clock for deterministic output in tests. */
  now?: () => Date;
  /** Already-loaded `fairux.config.*` content (the CLI loads it; this layer just consumes). */
  config?: FairuxConfig;
  /**
   * Path to record in the report (report metadata, evidence `source.file`, AST locators, SARIF
   * `artifactLocation.uri`). The file is READ from `filePath` (resolved/absolute), but the report
   * should carry the user's requested path — typically relative — so output is stable across
   * checkouts/runners and fingerprints don't shift with the absolute prefix. Defaults to `filePath`.
   */
  reportPath?: string;
  /**
   * Rule packs to compose, built-in first. Defaults to the built-in pack alone.
   *
   * The CLI loads and composes these once per invocation (see `load-rule-pack.ts`), so a malformed
   * or colliding pack is a refusal before anything is scanned rather than partway through a run.
   */
  rulePacks?: readonly RulePack[];
}

function emptySeverityCounts(): Record<Severity, number> {
  return { info: 0, low: 0, medium: 0, high: 0 };
}

/**
 * Stable report identity path. Filesystem access keeps its resolved path; report metadata,
 * locators, SARIF paths, and fingerprints get cwd-relative paths. Only the host separator is
 * normalized, so POSIX filenames containing a literal backslash remain distinct.
 */
export function toStableReportPath(
  filePath: string,
  cwd = process.cwd(),
  platformSeparator = sep,
): string {
  const relativePath = isAbsolute(filePath)
    ? toCwdRelativePath(filePath, cwd, platformSeparator)
    : filePath;
  return platformSeparator === "\\" ? relativePath.replaceAll("\\", "/") : relativePath;
}

function toCwdRelativePath(filePath: string, cwd: string, platformSeparator: string): string {
  const lexical = relative(resolve(cwd), filePath);
  if (!isOutsideCwd(lexical, platformSeparator)) return lexical;

  try {
    const realCwd = realpathSync.native(cwd);
    const realFile = realpathSync.native(filePath);
    const canonical = relative(realCwd, realFile);
    return isOutsideCwd(canonical, platformSeparator) ? lexical : canonical;
  } catch {
    return lexical;
  }
}

function isOutsideCwd(relativePath: string, platformSeparator: string): boolean {
  return (
    relativePath === ".." ||
    relativePath.startsWith(`..${platformSeparator}`) ||
    isAbsolute(relativePath)
  );
}

export function readUtf8FileBounded(filePath: string, maxBytes: number): BoundedFileContents {
  const fd = openSync(filePath, "r");
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) {
      throw new Error(`Not a file: ${filePath}`);
    }
    if (stat.size > maxBytes) {
      throw new InputTooLargeError(maxBytes, stat.size, "bytes");
    }

    const chunks: Buffer[] = [];
    const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, maxBytes + 1));
    let total = 0;
    while (total <= maxBytes) {
      const remaining = maxBytes + 1 - total;
      const bytesRead = readSync(fd, buffer, 0, Math.min(buffer.length, remaining), null);
      if (bytesRead === 0) break;
      chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
      total += bytesRead;
    }
    if (total > maxBytes) {
      throw new InputTooLargeError(maxBytes, total, "bytes");
    }
    return { source: Buffer.concat(chunks, total).toString("utf8"), byteLength: total };
  } finally {
    closeSync(fd);
  }
}

/**
 * Build a FairUxBatchReport from per-file reports.
 * Each file's report retains its own runtime and file path.
 * Finding IDs are namespaced as `<fileIndex>:<originalId>` to stay unique.
 * Stable fingerprints are preserved; batchOccurrenceId adds file context.
 * The aggregate summary rolls up all findings across all files.
 */
function buildBatchReport(
  reports: FairUxReport[],
  toolVersion: string,
  now: () => Date,
): FairUxBatchReport {
  const bySeverity = emptySeverityCounts();
  const byRuntime: Record<string, { total: number; bySeverity: Record<Severity, number> }> = {};
  const inputs: FairUxBatchReport["inputs"] = reports.map((report) => ({
    ...report.input,
    file: report.input.file ? toStableReportPath(report.input.file) : undefined,
  }));
  let totalFindings = 0;

  for (const report of reports) {
    const runtime = report.input.runtime;

    // Initialize runtime stats
    if (!byRuntime[runtime]) {
      byRuntime[runtime] = { total: 0, bySeverity: emptySeverityCounts() };
    }
    byRuntime[runtime].total += report.summary.total;
    totalFindings += report.summary.total;
    for (const [severity, count] of Object.entries(report.summary.bySeverity)) {
      byRuntime[runtime].bySeverity[severity as Severity] += count;
    }

    for (const finding of report.findings) {
      bySeverity[finding.severity]++;
    }
  }

  return {
    kind: "batch",
    schemaVersion: "0.1",
    toolVersion,
    generatedAt: now().toISOString(),
    inputs,
    rulePacks: reports[0]?.rulePacks,
    summary: {
      total: totalFindings,
      bySeverity,
      byRuntime,
    },
    reports: reports.map((report, i) => {
      const input = inputs[i] ?? report.input;
      return {
        input,
        summary: report.summary,
        // Per input, never rolled up: a directory can hold an HTML page and a Figma export, and the
        // two were not able to check the same things. One merged block would have to either
        // over-claim for the weaker input or under-claim for the stronger.
        ...(report.coverage ? { coverage: report.coverage } : {}),
        // Carried, not dropped. This function used to copy `input`, `summary`, `coverage`, and
        // `findings` and stop, so `fairux scan page.html` reported that an inline directive had
        // turned a rule off and `fairux scan .` did not — the same page, the same directive, and
        // the record gone because of how the target was named. Rolling them up would be worse than
        // dropping them: a reason belongs to the line it was written on.
        ...(report.suppressed ? { suppressed: report.suppressed } : {}),
        ...(report.suppressionDiagnostics
          ? { suppressionDiagnostics: report.suppressionDiagnostics }
          : {}),
        ...(report.aiAugmentation ? { aiAugmentation: report.aiAugmentation } : {}),
        findings: report.findings.map((finding) => ({
          ...finding,
          id: `${i}:${finding.id}`,
          fingerprint: finding.fingerprint,
          batchOccurrenceId: createBatchOccurrenceFingerprint(
            finding.fingerprint,
            input.file ?? "",
          ),
        })),
      };
    }),
  };
}

/**
 * Create a batch-specific occurrence identifier that includes file context.
 * Stable finding fingerprints stay unchanged; this prevents batch occurrence collisions.
 *
 * @param originalFingerprint - The original single-file fingerprint
 * @param filePath - Relative file path (normalized)
 * @returns A batch occurrence identifier that includes file context
 */
function createBatchOccurrenceFingerprint(originalFingerprint: string, filePath: string): string {
  // Create a stable file identifier (relative path, normalized separators)
  const normalizedFile = toStableReportPath(filePath);

  // Combine file path with original fingerprint using a null separator
  const combined = `${normalizedFile}\0${originalFingerprint}`;

  // Hash the combined string to create a stable occurrence identifier
  return createHash("sha256").update(combined).digest("hex").substring(0, 16);
}

/**
 * Rule metadata for SARIF's `tool.driver.rules`.
 *
 * Every composed pack, not only the built-in one: a report produced with an external pack whose
 * rules were missing from the driver would describe results whose rule ids the consumer cannot
 * resolve.
 */
function driverRuleMeta(rulePacks?: readonly RulePack[]): RuleMeta[] {
  return (rulePacks ?? [fairuxBuiltinRulePack]).flatMap((pack) =>
    pack.rules.map((rule) => rule.meta),
  );
}

export function renderReport(
  report: FairUxReport,
  format: OutputFormat,
  rulePacks?: readonly RulePack[],
  extras: HtmlReportOptions = {},
): string {
  switch (format) {
    case "json":
      return toJson(report);
    case "sarif":
      return toSarif(report, { rules: driverRuleMeta(rulePacks) });
    case "html":
      // The only format that takes the index: JSON and SARIF have their own homes for it, and a
      // Markdown report is read where a second file is easy to open beside it.
      return toHtml(report, extras);
    default:
      return toMarkdown(report);
  }
}

export function renderBatchReport(
  report: FairUxBatchReport,
  format: OutputFormat,
  rulePacks?: readonly RulePack[],
  extras: HtmlReportOptions = {},
): string {
  switch (format) {
    case "json":
      return JSON.stringify(report, null, 2);
    case "sarif":
      return toBatchSarif(report, { rules: driverRuleMeta(rulePacks) });
    case "html":
      return toBatchHtml(report, extras);
    default:
      return toBatchMarkdown(report);
  }
}

const AST_EXTENSIONS = new Set([".tsx", ".jsx", ".ts", ".js", ".mts", ".cts", ".mjs", ".cjs"]);

/** Check if a file is a Figma JSON file (.figma.json or .figjson). */
export function isFigmaFile(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  return lower.endsWith(".figma.json") || lower.endsWith(".figjson");
}

/**
 * Pick the adapter by file extension: JSX/TSX (and plain JS/TS) → the AST adapter;
 * .figma.json / .figjson → the Figma adapter; everything else → the static-HTML adapter.
 * The extension is taken from `filePath` (what we actually read);
 * the `file` recorded in the document is `reportPath` (what we display). AST findings are
 * static-only and confidence-capped at medium, because dynamic expressions are treated as unknown
 * rather than evaluated; HTML findings keep full locations.
 */
function parseByExtension(filePath: string, reportPath: string, source: string): UiDocument {
  if (isFigmaFile(filePath)) {
    return parseFigma(source, { file: reportPath });
  }
  return AST_EXTENSIONS.has(extname(filePath).toLowerCase())
    ? parseSource(source, { file: reportPath })
    : // Hashed here, where the bytes were read. A rule proposing a remediation copies this forward,
      // and it is what lets applying refuse a file that changed after the scan.
      //
      // Attribute ranges are on for every scan, not only for `--fix-dry-run` and `--fix-write`.
      // Capabilities decide which rules run, so a flag that switched one on would make
      // `fairux scan` and `fairux scan --fix-dry-run` capable of reporting different findings and
      // different exit codes for the same file — a fix flag must not be able to change a verdict.
      parseHtml(source, {
        file: reportPath,
        sourceChecksum: createHash("sha256").update(source, "utf8").digest("hex"),
        sourceRanges: true,
      });
}

function createConfiguredScanner(options: ScanFileOptions): FairuxScanner {
  const cfg = options.config ?? {};
  const includeExperimental = options.includeExperimental ?? cfg.includeExperimental ?? false;
  return createScanner({
    rulePacks: options.rulePacks ?? [fairuxBuiltinRulePack],
    ruleOverrides: cfg.rules,
    includeExperimental,
    toolVersion: options.toolVersion,
    now: options.now,
  });
}

function scanDocument(doc: UiDocument, options: ScanFileOptions): FairUxReport {
  return createConfiguredScanner(options).scan(doc);
}

/** One journey step, as the CLI has it: a file to read and where it sat in the flow. */
export interface JourneyStepInput {
  readonly id: string;
  readonly order: number;
  readonly path: string;
  readonly reportPath: string;
  readonly url?: string;
  readonly location?: string;
  readonly actionLabel?: string;
  readonly transition?: JourneyStep["transition"];
}

/**
 * Scan an ordered flow of files, through the same scanner and the same adapters a `scan` uses.
 *
 * Every step is read and parsed before any is scanned, so a journey with one unreadable step fails
 * as a journey rather than after reporting the steps before it — half a flow presented as a whole
 * one would say a cancellation path was checked when only its first page was.
 */
export function scanJourneyReport(
  steps: readonly JourneyStepInput[],
  options: ScanFileOptions,
): JourneyReport {
  const parsed: JourneyStep[] = steps.map((step) => {
    const { source } = readUtf8FileBounded(step.path, MAX_INPUT_BYTES);
    const reportPath = toStableReportPath(step.reportPath);
    return {
      id: step.id,
      order: step.order,
      document: parseByExtension(step.path, reportPath, source),
      ...(step.url !== undefined ? { url: step.url } : {}),
      ...(step.location !== undefined ? { location: step.location } : {}),
      ...(step.actionLabel !== undefined ? { actionLabel: step.actionLabel } : {}),
      ...(step.transition !== undefined ? { transition: step.transition } : {}),
    };
  });
  const cfg = options.config ?? {};
  return createConfiguredScanner({ ...options, config: cfg }).scanJourney({ steps: parsed });
}

/**
 * Whether a journey meets the `--fail-on` threshold, across **both** layers.
 *
 * Decided rather than inherited. A journey's own findings and its steps' are disjoint sets, and a
 * user asking to fail on anything at or above a severity means anything: a threshold that ignored
 * one layer would pass a flow whose every step is broken, or one whose commitment changes between
 * pages, depending on which half it was written against.
 */
export function shouldFailOnJourney(report: JourneyReport, threshold: FailOnSeverity): boolean {
  const minRank = SEVERITY_RANK[threshold];
  const findings: readonly Finding[] = [
    ...report.findings,
    ...report.steps.flatMap((step) => step.report.findings),
  ];
  return findings.some((finding) => SEVERITY_RANK[finding.severity] >= minRank);
}

const SCAN_EXTENSIONS = new Set([
  ".html",
  ".htm",
  ".tsx",
  ".jsx",
  ".ts",
  ".js",
  ".mts",
  ".cts",
  ".mjs",
  ".cjs",
  ".figjson",
]);

const SEVERITY_RANK: Record<Severity, number> = {
  info: 0,
  low: 1,
  medium: 2,
  high: 3,
};

/** Check if a file extension is scannable by FairUX. */
export function isScannableExtension(ext: string): boolean {
  return SCAN_EXTENSIONS.has(ext.toLowerCase());
}

/** The severity threshold for --fail-on. */
export type FailOnSeverity = "high" | "medium" | "low" | "info";

/** Check if any finding meets or exceeds the --fail-on severity threshold. */
export function shouldFailOn(
  report: FairUxReport | FairUxBatchReport,
  threshold: FailOnSeverity,
): boolean {
  const minRank = SEVERITY_RANK[threshold];
  const findings =
    report.kind === "batch" ? report.reports.flatMap((r) => r.findings) : report.findings;
  return findings.some((f: Finding) => SEVERITY_RANK[f.severity] >= minRank);
}

/** Read a UI source file, scan it with all rules (adapter chosen by extension), and render. */
export function scanFile(filePath: string, options: ScanFileOptions): string {
  return renderReport(scanFileReport(filePath, options), options.format);
}

/** Scan a single file and return the raw report (no rendering). */
export function scanFileReport(filePath: string, options: ScanFileOptions): FairUxReport {
  const { source } = readUtf8FileBounded(filePath, MAX_INPUT_BYTES);
  const reportPath = options.reportPath
    ? toStableReportPath(options.reportPath)
    : toStableReportPath(filePath);
  const cfg = options.config ?? {};
  return scanDocument(parseByExtension(filePath, reportPath, source), { ...options, config: cfg });
}

/** Scan a source string (for stdin) with a forced adapter type. */
export function scanSource(source: string, fileLabel: string, options: ScanFileOptions): string {
  return renderReport(scanSourceReport(source, fileLabel, options), options.format);
}

/** Scan a source string and return the raw report (no rendering). */
export function scanSourceReport(
  source: string,
  fileLabel: string,
  options: ScanFileOptions,
): FairUxReport {
  // Check actual byte length (UTF-8), not UTF-16 code units
  const actualByteLength = Buffer.byteLength(source, "utf8");
  if (actualByteLength > MAX_INPUT_BYTES) {
    throw new InputTooLargeError(MAX_INPUT_BYTES, actualByteLength, "bytes");
  }
  const cfg = options.config ?? {};
  const reportPath = toStableReportPath(fileLabel);
  const doc = parseByExtension(fileLabel, reportPath, source);
  return scanDocument(doc, { ...options, config: cfg });
}

/** Maximum number of files in a batch scan (directory/glob). */
export const MAX_BATCH_FILES = 500;
/** Maximum total bytes across all files in a batch scan. */
export const MAX_BATCH_TOTAL_BYTES = 100 * 1024 * 1024; // 100 MB
/** Maximum total findings across all files in a batch scan. */
export const MAX_BATCH_FINDINGS = 10_000;

/** Scan multiple files and return a batch report with per-file results. */
export function scanFiles(filePaths: string[], options: ScanFileOptions): string {
  return renderBatchReport(scanFilesReport(filePaths, options), options.format);
}

/** Scan multiple files and return the raw batch report (no rendering). */
export function scanFilesReport(filePaths: string[], options: ScanFileOptions): FairUxBatchReport {
  if (filePaths.length > MAX_BATCH_FILES) {
    throw new BatchLimitError(MAX_BATCH_FILES, filePaths.length, "files");
  }
  const cfg = options.config ?? {};
  const now = options.now ?? (() => new Date());
  const toolVersion = options.toolVersion ?? "0.0.0";
  const scanner = createConfiguredScanner({ ...options, config: cfg, toolVersion, now });
  const reports: FairUxReport[] = [];
  let totalBytes = 0;
  let totalFindings = 0;
  for (const filePath of filePaths) {
    const { source, byteLength } = readUtf8FileBounded(filePath, MAX_INPUT_BYTES);
    totalBytes += byteLength;
    if (totalBytes > MAX_BATCH_TOTAL_BYTES) {
      throw new InputTooLargeError(MAX_BATCH_TOTAL_BYTES, totalBytes, "bytes");
    }
    const reportPath = toStableReportPath(filePath);
    const report = scanner.scan(parseByExtension(filePath, reportPath, source));
    totalFindings += report.findings.length;
    if (totalFindings > MAX_BATCH_FINDINGS) {
      throw new BatchLimitError(MAX_BATCH_FINDINGS, totalFindings, "findings");
    }
    reports.push(report);
  }
  return buildBatchReport(reports, toolVersion, now);
}
