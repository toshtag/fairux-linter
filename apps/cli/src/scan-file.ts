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
  MAX_INPUT_BYTES,
  type Severity,
  type UiDocument,
} from "@fairux/core";
import { parseFigma } from "@fairux/figma";
import { parseHtml } from "@fairux/html";
import { toBatchMarkdown, toBatchSarif, toJson, toMarkdown, toSarif } from "@fairux/report";
import { fairuxBuiltinRulePack } from "@fairux/rules";

export type OutputFormat = "json" | "markdown" | "sarif";
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

export function renderReport(report: FairUxReport, format: OutputFormat): string {
  switch (format) {
    case "json":
      return toJson(report);
    case "sarif":
      return toSarif(report, { rules: fairuxBuiltinRulePack.rules.map((r) => r.meta) });
    default:
      return toMarkdown(report);
  }
}

export function renderBatchReport(report: FairUxBatchReport, format: OutputFormat): string {
  switch (format) {
    case "json":
      return JSON.stringify(report, null, 2);
    case "sarif":
      return toBatchSarif(report, { rules: fairuxBuiltinRulePack.rules.map((r) => r.meta) });
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
 * static-only and confidence-capped at medium (see ADR P6-T2); HTML findings keep full locations.
 */
function parseByExtension(filePath: string, reportPath: string, source: string): UiDocument {
  if (isFigmaFile(filePath)) {
    return parseFigma(source, { file: reportPath });
  }
  return AST_EXTENSIONS.has(extname(filePath).toLowerCase())
    ? parseSource(source, { file: reportPath })
    : parseHtml(source, { file: reportPath });
}

function createConfiguredScanner(options: ScanFileOptions): FairuxScanner {
  const cfg = options.config ?? {};
  const includeExperimental = options.includeExperimental ?? cfg.includeExperimental ?? false;
  return createScanner({
    rulePacks: [fairuxBuiltinRulePack],
    ruleOverrides: cfg.rules,
    includeExperimental,
    toolVersion: options.toolVersion,
    now: options.now,
  });
}

function scanDocument(doc: UiDocument, options: ScanFileOptions): FairUxReport {
  return createConfiguredScanner(options).scan(doc);
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
