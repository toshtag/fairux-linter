import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, extname, isAbsolute, relative, resolve } from "node:path";
import type { FairuxConfig } from "@fairux/core";
import { Command } from "commander";
import fastGlob from "fast-glob";

const { globSync } = fastGlob;

import { explainRule, renderRuleExplanation, UnknownRuleError } from "./explain-rule.js";
import {
  globMagicIndex,
  isGlobPattern,
  isUncPattern,
  toPortableGlobPattern,
} from "./glob-target.js";
import { listRules, renderRuleListing } from "./list-rules.js";
import {
  discoverConfig,
  formatTerminalError,
  loadConfig,
  parseJsonConfig,
  sanitizeForTerminal,
} from "./load-config.js";
import { composeCliRulePacks } from "./load-rule-pack.js";
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
const VALID_RULES_FORMATS: ReadonlySet<string> = new Set(["text", "json"]);
const VALID_EXPLAIN_FORMATS: ReadonlySet<string> = VALID_RULES_FORMATS;

/** Maximum directory walk depth to prevent infinite recursion on pathological structures. */
const MAX_DIR_DEPTH = 50;

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

/**
 * Where config discovery starts for a glob.
 *
 * Takes the pattern in the expander's own form — see {@link toPortableGlobPattern} — so `/` is the
 * only separator it has to recognise, on every platform.
 */
function resolveGlobConfigBase(pattern: string, cwd = process.cwd()): string {
  const magicIndex = globMagicIndex(pattern);
  if (magicIndex < 0) return cwd;

  const prefix = pattern.slice(0, magicIndex);
  const lastSeparator = prefix.lastIndexOf("/");
  if (lastSeparator < 0) return cwd;

  let fixedPrefix = prefix.slice(0, lastSeparator);
  if (fixedPrefix === "" && prefix.startsWith("/")) fixedPrefix = "/";
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

/**
 * The config a command runs under, resolved the one way for every command.
 *
 * `scan` and `rules` must agree about which config applies, or `rules` would describe a rule set
 * that the scan beside it does not use — which is the one failure this command cannot afford.
 * Diagnostics are written here so the answer is a config or a refusal, never a partial one.
 */
async function resolveEffectiveConfig(options: {
  explicitPath?: string;
  ignoreConfig: boolean;
  basePath: string;
}): Promise<{ ok: true; config: FairuxConfig | undefined } | { ok: false }> {
  if (options.explicitPath) {
    return {
      ok: true,
      config: await loadConfig(options.explicitPath, {
        allowExecutable: true,
        onBeforeExecute: (p) =>
          process.stderr.write(
            `fairux: executing config "${sanitizeForTerminal(p)}" as trusted code — it runs ` +
              `with your privileges. Only do this for configs you trust.\n`,
          ),
      }),
    };
  }
  if (options.ignoreConfig) return { ok: true, config: undefined };

  const { configPath, contents, diagnostics } = discoverConfig(options.basePath);
  for (const d of diagnostics) {
    const safePath = sanitizeForTerminal(d.path);
    const line =
      d.level === "error"
        ? `refusing auto-discovered config "${safePath}": ${d.message}`
        : `found "${safePath}" — ${d.message}`;
    process.stderr.write(`fairux: ${line}\n`);
  }
  if (diagnostics.some((d) => d.level === "error")) return { ok: false };
  if (!configPath || contents === undefined) return { ok: true, config: undefined };

  try {
    return { ok: true, config: parseJsonConfig(contents, configPath) };
  } catch (error) {
    process.stderr.write(
      `fairux: config error in "${sanitizeForTerminal(configPath)}": ${formatTerminalError(error)}\n`,
    );
    return { ok: false };
  }
}

/**
 * Load and compose the packs a command runs with.
 *
 * The warning is printed by path, immediately before the module is imported, for the same reason an
 * executable `--config` prints one: a RulePack is executable JavaScript and FairUX does not sandbox
 * it. It goes to stderr so `--format json` on stdout stays parseable.
 */
async function composeRulePacksForRun(
  packPaths: readonly string[] | undefined,
  includeExperimental: boolean,
) {
  return composeCliRulePacks(packPaths ?? [], {
    includeExperimental,
    onBeforeExecute: (p) =>
      process.stderr.write(
        `fairux: loading rule pack "${sanitizeForTerminal(p)}" as trusted code — it runs with ` +
          `your privileges and is not sandboxed. Only do this for packs you trust.\n`,
      ),
  });
}

interface RulesCliOptions {
  format: string;
  includeExperimental?: boolean;
  config?: string;
  ignoreConfig: boolean;
  rulePack?: string[];
}

interface ScanCliOptions {
  format: string;
  includeExperimental?: boolean;
  config?: string;
  ignoreConfig: boolean;
  failOn?: string;
  rulePack?: string[];
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
    "--rule-pack <path>",
    "load an external RulePack (repeatable). It is executable code and is not sandboxed",
    (value: string, previous: string[] = []) => [...previous, value],
  )
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
      // The expander has no UNC, device, or extended-length support, so translating one of those
      // into its own form would report "matched nothing" for a target it never looked at. A
      // directory or a direct file on the same share is unaffected and stays the way through.
      if (isGlob && isUncPattern(path, process.platform)) {
        process.stderr.write(
          `fairux: glob patterns are not supported for UNC, device, or extended-length paths ` +
            `("${sanitizeForTerminal(path)}") — scan the directory itself instead\n`,
        );
        process.exitCode = 2;
        return;
      }
      // `\` is a path separator on Windows and an escape character in a glob, and no shell there
      // resolves that for us. Settled once, before the pattern is used to expand or to locate a
      // config, so both answer for the same set of files.
      const globPattern = isGlob ? toPortableGlobPattern(path, process.platform) : path;
      // For stdin, use cwd directly. For directories, use the directory itself.
      // For files, use the containing directory.
      let configBasePath: string;
      if (isStdin) {
        configBasePath = process.cwd();
      } else if (isGlob) {
        configBasePath = resolveGlobConfigBase(globPattern);
      } else {
        const resolved = resolvedTarget ?? resolve(path);
        const stat = statSync(resolved);
        configBasePath = stat.isDirectory() ? resolved : dirname(resolved);
      }
      const resolvedConfig = await resolveEffectiveConfig({
        explicitPath: options.config,
        ignoreConfig: options.ignoreConfig,
        basePath: configBasePath,
      });
      if (!resolvedConfig.ok) {
        process.exitCode = 1;
        return;
      }
      const config = resolvedConfig.config;

      const includeExperimental =
        options.includeExperimental || config?.includeExperimental || false;
      // Composed before any input is read, so a malformed pack or a rule id colliding with a
      // built-in one is a refusal rather than a half-finished scan.
      const { packs } = await composeRulePacksForRun(options.rulePack, includeExperimental);

      const scanOpts = {
        format: options.format as OutputFormat,
        includeExperimental,
        toolVersion: VERSION,
        config,
        rulePacks: packs,
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
        const output = renderReport(report, options.format as OutputFormat, packs);
        process.stdout.write(output.endsWith("\n") ? output : `${output}\n`);
        if (options.failOn && shouldFailOn(report, options.failOn as FailOnSeverity)) {
          process.exitCode = 1;
        }
        return;
      }

      const targetPath = resolvedTarget ?? resolve(path);
      const filesToScan: string[] = [];

      if (isGlob) {
        filesToScan.push(...expandGlob(globPattern));
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
        const output = renderBatchReport(batchReport, options.format as OutputFormat, packs);
        process.stdout.write(output.endsWith("\n") ? output : `${output}\n`);
        if (options.failOn && shouldFailOn(batchReport, options.failOn as FailOnSeverity)) {
          process.exitCode = 1;
        }
      } else {
        const singleReport = scanFileReport(singleFile, {
          ...scanOpts,
          reportPath: singleReportPath,
        });
        const output = renderReport(singleReport, options.format as OutputFormat, packs);
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

program
  .command("rules")
  .description("list the rules a scan would run, with their effective state")
  .option("-f, --format <format>", "output format: text | json", "text")
  .option("--include-experimental", "also list experimental (heuristic) rules as enabled")
  .option(
    "--config <path>",
    "path to a fairux.config file (.json, or executable .ts/.mjs/.js/.cjs you trust); " +
      "when omitted, only fairux.config.json is auto-discovered",
  )
  .option("--ignore-config", "skip automatic config discovery", false)
  .option(
    "--rule-pack <path>",
    "load an external RulePack (repeatable). It is executable code and is not sandboxed",
    (value: string, previous: string[] = []) => [...previous, value],
  )
  .action(async (options: RulesCliOptions) => {
    if (!VALID_RULES_FORMATS.has(options.format)) {
      process.stderr.write(`fairux: unknown format "${options.format}" (use text or json)\n`);
      process.exitCode = 2;
      return;
    }
    try {
      // Config discovery starts from the working directory: there is no target to take a base from,
      // and a listing that silently used a different config than the scan beside it would be worse
      // than no listing at all.
      const resolved = await resolveEffectiveConfig({
        explicitPath: options.config,
        ignoreConfig: options.ignoreConfig,
        basePath: process.cwd(),
      });
      if (!resolved.ok) {
        process.exitCode = 1;
        return;
      }

      const { packs } = await composeRulePacksForRun(
        options.rulePack,
        options.includeExperimental ?? resolved.config?.includeExperimental ?? false,
      );
      const listing = listRules({
        config: resolved.config,
        includeExperimental: options.includeExperimental,
        rulePacks: packs,
      });
      const output =
        options.format === "json" ? JSON.stringify(listing, null, 2) : renderRuleListing(listing);
      process.stdout.write(output.endsWith("\n") ? output : `${output}\n`);
    } catch (error) {
      process.stderr.write(`fairux: ${formatTerminalError(error)}\n`);
      process.exitCode = 1;
    }
  });

program
  .command("explain")
  .argument("<rule-id>", "id of the rule to explain, e.g. consent/checked-checkbox")
  .description("explain one rule: what it needs, what it cannot see, and the sources behind it")
  .option("-f, --format <format>", "output format: text | json", "text")
  .option("--include-experimental", "resolve enablement as if experimental rules were enabled")
  .option(
    "--config <path>",
    "path to a fairux.config file (.json, or executable .ts/.mjs/.js/.cjs you trust); " +
      "when omitted, only fairux.config.json is auto-discovered",
  )
  .option("--ignore-config", "skip automatic config discovery", false)
  .option(
    "--rule-pack <path>",
    "load an external RulePack (repeatable). It is executable code and is not sandboxed",
    (value: string, previous: string[] = []) => [...previous, value],
  )
  .action(async (ruleId: string, options: RulesCliOptions) => {
    if (!VALID_EXPLAIN_FORMATS.has(options.format)) {
      process.stderr.write(`fairux: unknown format "${options.format}" (use text or json)\n`);
      process.exitCode = 2;
      return;
    }
    try {
      const resolved = await resolveEffectiveConfig({
        explicitPath: options.config,
        ignoreConfig: options.ignoreConfig,
        basePath: process.cwd(),
      });
      if (!resolved.ok) {
        process.exitCode = 1;
        return;
      }

      const { packs } = await composeRulePacksForRun(
        options.rulePack,
        options.includeExperimental ?? resolved.config?.includeExperimental ?? false,
      );
      const explanation = explainRule(ruleId, {
        config: resolved.config,
        includeExperimental: options.includeExperimental,
        rulePacks: packs,
      });
      const output =
        options.format === "json"
          ? JSON.stringify(explanation, null, 2)
          : renderRuleExplanation(explanation);
      process.stdout.write(output.endsWith("\n") ? output : `${output}\n`);
    } catch (error) {
      // An unknown rule id is a usage error, like an unknown format: the invocation names something
      // that does not exist, rather than the run failing partway through.
      process.stderr.write(`fairux: ${formatTerminalError(error)}\n`);
      process.exitCode = error instanceof UnknownRuleError ? 2 : 1;
    }
  });

program.parse();
