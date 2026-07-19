import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, extname, isAbsolute, relative, resolve } from "node:path";
import type { FairuxConfig } from "@fairux/core";
import { Command } from "commander";
import fastGlob from "fast-glob";

const { globSync } = fastGlob;

import {
  discoverConfig,
  formatTerminalError,
  loadConfig,
  parseJsonConfig,
  sanitizeForTerminal,
} from "./load-config.js";
import {
  BatchLimitError,
  type FailOnSeverity,
  isFigmaFile,
  isScannableExtension,
  MAX_BATCH_FILES,
  type OutputFormat,
  renderBatchReport,
  renderReport,
  scanFileReport,
  scanFilesReport,
  scanSourceReport,
  shouldFailOn,
  toStableReportPath,
} from "./scan-file.js";
import { VERSION } from "./version.js";

const VALID_FORMATS: ReadonlySet<string> = new Set(["json", "markdown", "sarif"]);
const VALID_FAIL_ON: ReadonlySet<string> = new Set(["high", "medium", "low", "info"]);
const GLOB_CHARS = new Set(["*", "?", "[", "{"]);

/** Maximum directory walk depth to prevent infinite recursion on pathological structures. */
const MAX_DIR_DEPTH = 50;

function isGlobPattern(p: string): boolean {
  return [...p].some((c) => GLOB_CHARS.has(c));
}

function nearestExistingDirectory(path: string, fallback: string): string {
  let current = path;
  while (true) {
    try {
      if (existsSync(current)) {
        const stat = statSync(current);
        return stat.isDirectory() ? current : dirname(current);
      }
    } catch {
      // Keep walking toward the fallback.
    }
    const parent = dirname(current);
    if (parent === current) return fallback;
    if (!isAbsolute(path) && relative(fallback, parent).startsWith("..")) return fallback;
    current = parent;
  }
}

function resolveGlobConfigBase(pattern: string, cwd = process.cwd()): string {
  const magicIndex = [...pattern].findIndex((c) => GLOB_CHARS.has(c));
  if (magicIndex < 0) return cwd;

  const prefix = pattern.slice(0, magicIndex);
  const lastSeparator = Math.max(prefix.lastIndexOf("/"), prefix.lastIndexOf("\\"));
  if (lastSeparator < 0) return cwd;

  let fixedPrefix = prefix.slice(0, lastSeparator);
  if (fixedPrefix === "" && /^[\\/]/.test(prefix)) fixedPrefix = prefix[0] ?? "";
  if (fixedPrefix === "") return cwd;

  const candidate = resolve(cwd, fixedPrefix);
  return nearestExistingDirectory(candidate, cwd);
}

/**
 * Expand a glob pattern using a stable implementation.
 * Excludes node_modules and .git directories. Returns sorted results.
 * Throws meaningful errors for malformed patterns or filesystem issues.
 */
function expandGlob(pattern: string): string[] {
  const cwd = process.cwd();
  try {
    // Use globSync with proper error handling
    const matches = globSync(pattern, {
      cwd,
      ignore: ["**/node_modules/**", "**/.git/**"],
    });

    const filtered = matches
      .map((m) => resolve(cwd, m))
      .filter((f) => isScannableExtension(extname(f)) || isFigmaFile(f));

    // Check file count limit during glob expansion
    if (filtered.length > MAX_BATCH_FILES) {
      throw new BatchLimitError(MAX_BATCH_FILES, filtered.length, "files");
    }

    return filtered.sort();
  } catch (error) {
    // Don't silently swallow errors - provide meaningful feedback
    if (error instanceof BatchLimitError) {
      throw error;
    }
    if (error instanceof Error) {
      // Re-throw with context about the pattern
      throw new Error(`Failed to expand glob pattern "${pattern}": ${error.message}`);
    }
    throw error;
  }
}

interface ScanCliOptions {
  format: string;
  includeExperimental?: boolean;
  config?: string;
  ignoreConfig: boolean;
  failOn?: string;
}

const program = new Command();

program
  .name("fairux")
  .description("Detect UI patterns that may distort user decision-making (UX risk signals).")
  .version(VERSION);

program
  .command("scan")
  .argument("<path>", "path to a file, directory, or glob pattern to scan (use '-' for stdin)")
  .option("-f, --format <format>", "output format: json | markdown | sarif", "markdown")
  .option("--include-experimental", "also run experimental (heuristic) rules")
  .option(
    "--config <path>",
    "path to a fairux.config file (.json, or executable .ts/.mjs/.js/.cjs you trust); " +
      "when omitted, only fairux.config.json is auto-discovered",
  )
  .option("--ignore-config", "skip automatic config discovery", false)
  .option(
    "--fail-on <severity>",
    "exit with code 1 if any finding meets or exceeds this severity (high | medium | low | info)",
  )
  .action(async (path: string, options: ScanCliOptions) => {
    if (!VALID_FORMATS.has(options.format)) {
      process.stderr.write(
        `fairux: unknown format "${options.format}" (use json, markdown, or sarif)\n`,
      );
      process.exitCode = 2;
      return;
    }
    if (options.failOn && !VALID_FAIL_ON.has(options.failOn)) {
      process.stderr.write(
        `fairux: unknown --fail-on severity "${options.failOn}" (use high, medium, low, or info)\n`,
      );
      process.exitCode = 2;
      return;
    }
    try {
      const isStdin = path === "-";
      const resolvedTarget = isStdin ? undefined : resolve(path);
      const literalTargetExists = resolvedTarget !== undefined && existsSync(resolvedTarget);
      const isGlob = !isStdin && !literalTargetExists && isGlobPattern(path);
      let config: FairuxConfig | undefined;
      if (options.config) {
        config = await loadConfig(options.config, {
          allowExecutable: true,
          onBeforeExecute: (p) =>
            process.stderr.write(
              `fairux: executing config "${sanitizeForTerminal(p)}" as trusted code — it runs ` +
                `with your privileges. Only do this for configs you trust.\n`,
            ),
        });
      } else if (!options.ignoreConfig) {
        // For stdin, use cwd directly. For directories, use the directory itself.
        // For files, use the containing directory.
        let configBasePath: string;
        if (isStdin) {
          configBasePath = process.cwd();
        } else if (isGlob) {
          configBasePath = resolveGlobConfigBase(path);
        } else {
          const resolved = resolvedTarget ?? resolve(path);
          const stat = statSync(resolved);
          if (stat.isDirectory()) {
            configBasePath = resolved;
          } else {
            configBasePath = dirname(resolved);
          }
        }
        const { configPath, contents, diagnostics } = discoverConfig(configBasePath);
        for (const d of diagnostics) {
          const safePath = sanitizeForTerminal(d.path);
          const line =
            d.level === "error"
              ? `refusing auto-discovered config "${safePath}": ${d.message}`
              : `found "${safePath}" — ${d.message}`;
          process.stderr.write(`fairux: ${line}\n`);
        }
        if (diagnostics.some((d) => d.level === "error")) {
          process.exitCode = 1;
          return;
        }
        if (configPath && contents !== undefined) {
          try {
            config = parseJsonConfig(contents, configPath);
          } catch (error) {
            const safePath = sanitizeForTerminal(configPath);
            const message = formatTerminalError(error);
            process.stderr.write(`fairux: config error in "${safePath}": ${message}\n`);
            process.exitCode = 1;
            return;
          }
        }
      }

      const scanOpts = {
        format: options.format as OutputFormat,
        includeExperimental: options.includeExperimental || config?.includeExperimental || false,
        toolVersion: VERSION,
        config,
      };

      if (isStdin) {
        const chunks: Buffer[] = [];
        let totalBytes = 0;
        const MAX_STDIN_BYTES = 10 * 1024 * 1024;
        for await (const chunk of process.stdin) {
          totalBytes += chunk.length;
          if (totalBytes > MAX_STDIN_BYTES) {
            process.stderr.write(
              `fairux: stdin exceeds ${MAX_STDIN_BYTES} byte limit — aborting\n`,
            );
            process.exitCode = 1;
            return;
          }
          chunks.push(chunk as Buffer);
        }
        const source = Buffer.concat(chunks).toString("utf8");
        const report = scanSourceReport(source, "stdin.html", scanOpts);
        const output = renderReport(report, options.format as OutputFormat);
        process.stdout.write(output.endsWith("\n") ? output : `${output}\n`);
        if (options.failOn && shouldFailOn(report, options.failOn as FailOnSeverity)) {
          process.exitCode = 1;
        }
        return;
      }

      const targetPath = resolvedTarget ?? resolve(path);
      const filesToScan: string[] = [];

      if (isGlob) {
        filesToScan.push(...expandGlob(path));
      } else {
        const stat = statSync(targetPath);
        if (stat.isDirectory()) {
          const walk = (dir: string, depth: number): void => {
            if (depth > MAX_DIR_DEPTH) {
              throw new Error(`Directory depth exceeded maximum of ${MAX_DIR_DEPTH} at "${dir}"`);
            }
            for (const entry of readdirSync(dir, { withFileTypes: true })) {
              const full = resolve(dir, entry.name);
              if (entry.isDirectory()) {
                if (entry.name === "node_modules" || entry.name === ".git") continue;
                walk(full, depth + 1);
              } else if (
                entry.isFile() &&
                (isScannableExtension(extname(full)) || isFigmaFile(full))
              ) {
                // Check file count limit during enumeration
                if (filesToScan.length >= MAX_BATCH_FILES) {
                  throw new BatchLimitError(MAX_BATCH_FILES, filesToScan.length + 1, "files");
                }
                filesToScan.push(full);
              }
            }
          };
          walk(targetPath, 0);
          filesToScan.sort();
        } else {
          filesToScan.push(targetPath);
        }
      }

      if (filesToScan.length === 0) {
        process.stderr.write("fairux: no scannable files found\n");
        process.exitCode = 1;
        return;
      }

      const singleFile = filesToScan[0];
      if (!singleFile) {
        process.stderr.write("fairux: no scannable files found\n");
        process.exitCode = 1;
        return;
      }
      const singleReportPath = toStableReportPath(singleFile);
      const isBatch = filesToScan.length > 1;
      if (isBatch) {
        const batchReport = scanFilesReport(filesToScan, scanOpts);
        const output = renderBatchReport(batchReport, options.format as OutputFormat);
        process.stdout.write(output.endsWith("\n") ? output : `${output}\n`);
        if (options.failOn && shouldFailOn(batchReport, options.failOn as FailOnSeverity)) {
          process.exitCode = 1;
        }
      } else {
        const singleReport = scanFileReport(singleFile, {
          ...scanOpts,
          reportPath: singleReportPath,
        });
        const output = renderReport(singleReport, options.format as OutputFormat);
        process.stdout.write(output.endsWith("\n") ? output : `${output}\n`);
        if (options.failOn && shouldFailOn(singleReport, options.failOn as FailOnSeverity)) {
          process.exitCode = 1;
        }
      }
    } catch (error) {
      process.stderr.write(`fairux: ${formatTerminalError(error)}\n`);
      process.exitCode = 1;
    }
  });

program.parse();
