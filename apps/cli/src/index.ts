import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, extname, isAbsolute, relative, resolve } from "node:path";
import type { FairuxConfig, RiskIndexReport, Runtime } from "@fairux/core";
import { MAX_INPUT_BYTES } from "@fairux/core";
import { toJourneyMarkdown } from "@fairux/report";
import { Command } from "commander";
import fastGlob from "fast-glob";

const { globSync } = fastGlob;

import {
  applyBaseline,
  createBaseline,
  describeBaselineApplication,
  readBaseline,
  writeBaseline,
} from "./baseline.js";
import { explainRule, renderRuleExplanation, UnknownRuleError } from "./explain-rule.js";
import { describeFixPlan, planFixes, writeFixes } from "./fix.js";
import {
  globMagicIndex,
  isGlobPattern,
  isUncPattern,
  toPortableGlobPattern,
} from "./glob-target.js";
import { type IgnoreMatcher, loadIgnoreFile, noIgnore } from "./ignore-file.js";
import { JourneyFileError, parseJourneyFile } from "./journey-file.js";
import { listRules, renderRuleListing } from "./list-rules.js";
import {
  discoverConfig,
  formatTerminalError,
  loadConfig,
  parseJsonConfig,
  sanitizeForTerminal,
} from "./load-config.js";
import { composeCliRulePacks } from "./load-rule-pack.js";
import { assertNoOutputCollisions, OutputCollisionError, type PathRole } from "./path-identity.js";
import {
  buildRiskIndex,
  DEFAULT_RISK_INDEX_MODEL_VERSION,
  describeRiskIndex,
  RISK_INDEX_MODEL_VERSIONS,
  writeRiskIndex,
} from "./risk-index.js";
import {
  BatchLimitError,
  type FailOnSeverity,
  isFigmaFile,
  isScannableExtension,
  MAX_BATCH_FILES,
  type OutputFormat,
  readUtf8FileBounded,
  renderBatchReport,
  renderReport,
  scanFileReport,
  scanFilesReport,
  scanJourneyReport,
  scanSourceReport,
  shouldFailOn,
  shouldFailOnJourney,
  toStableReportPath,
} from "./scan-file.js";
import {
  VALID_FAIL_ON as SCAN_FAIL_ON,
  VALID_FORMATS,
  validateScanOptions,
} from "./scan-options.js";
import {
  applySuppressions,
  describeSuppressionApplication,
  readSuppressions,
} from "./suppressions.js";
import { VERSION } from "./version.js";

const VALID_JOURNEY_FORMATS: ReadonlySet<string> = new Set(["json", "markdown"]);
/**
 * Why each format a journey does not have is refused, rather than a shared "unsupported".
 *
 * Both are open questions with answers written down elsewhere, and a reader who asked for one has
 * earned the reason instead of a list of what is left.
 */
const JOURNEY_FORMAT_REFUSALS: Readonly<Record<string, string>> = Object.freeze({
  sarif:
    "a journey finding has no physical location of its own and must be anchored to its step's " +
    "file — the rule is written in docs/reference/report-schema.md and is not implemented",
  html:
    "the HTML report renders one document with one coverage panel; a journey has two disjoint " +
    "layers and a coverage panel per step, which is a layout decision rather than a port",
});
/** `scan-journey`'s own threshold check. `scan`'s lives in {@link validateScanOptions}. */
const VALID_FAIL_ON: ReadonlySet<string> = new Set(["high", "medium", "low", "info"]);
const VALID_RULES_FORMATS: ReadonlySet<string> = new Set(["text", "json"]);
const VALID_RUNTIMES: ReadonlySet<string> = new Set(["html", "dom", "ast", "figma"]);

/** Narrow a flag value to a `Runtime`, so a typo is refused rather than silently listing nothing. */
function isRuntime(value: string): value is Runtime {
  return VALID_RUNTIMES.has(value);
}
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
function expandGlob(pattern: string, ignore: IgnoreMatcher): string[] {
  const cwd = process.cwd();
  try {
    // Use globSync with proper error handling
    const matches = globSync(pattern, {
      cwd,
      ignore: ["**/node_modules/**", "**/.git/**"],
    });

    const filtered = matches
      .map((m) => resolve(cwd, m))
      .filter((f) => isScannableExtension(extname(f)) || isFigmaFile(f))
      // A glob is a request for a set, not for named files, so `.fairuxignore` applies to it for
      // the same reason it applies to a directory walk.
      .filter((f) => !ignore.ignores(f));

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
}): Promise<{ ok: true; config: FairuxConfig | undefined; configPath?: string } | { ok: false }> {
  if (options.explicitPath) {
    return {
      ok: true,
      configPath: options.explicitPath,
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
    return { ok: true, configPath, config: parseJsonConfig(contents, configPath) };
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
  runtime?: string;
}

interface ScanCliOptions {
  format: string;
  includeExperimental?: boolean;
  config?: string;
  ignoreConfig: boolean;
  failOn?: string;
  rulePack?: string[];
  baseline?: string;
  writeBaseline?: string;
  suppress?: string;
  /**
   * Commander maps `--no-ignore` to this key, defaulting to `true`. Named for the positive so the
   * flag reads the way ESLint's does; `--ignore-config` beside it governs the config file, not this.
   */
  ignore: boolean;
  /** Where to write the Risk Index. Absent means none is computed at all. */
  riskIndex?: string;
  /** Which model scores it. Absent means the default, which does not move on its own. */
  riskIndexModel?: string;
  fixDryRun?: boolean;
  fixWrite?: boolean;
}

const program = new Command();

program
  .name("fairux")
  .description("Detect UI patterns that may distort user decision-making (UX risk signals).")
  .version(VERSION);

program
  .command("scan")
  .argument("<path>", "path to a file, directory, or glob pattern to scan (use '-' for stdin)")
  .option("-f, --format <format>", `output format: ${VALID_FORMATS.join(" | ")}`, "markdown")
  .option("--include-experimental", "also run experimental (heuristic) rules")
  .option(
    "--config <path>",
    "path to a fairux.config file (.json, or executable .ts/.mjs/.js/.cjs you trust); " +
      "when omitted, only fairux.config.json is auto-discovered",
  )
  .option("--ignore-config", "skip automatic config discovery", false)
  .option("--no-ignore", "scan paths a discovered .fairuxignore would exclude")
  .option(
    "--baseline <file>",
    "subtract findings recorded in a baseline file — accepted risk, not resolved risk",
  )
  .option(
    "--write-baseline <file>",
    "write this scan's findings to a baseline file instead of reporting them",
  )
  .option(
    "--suppress <file>",
    "apply a suppressions file — each entry needs a reason, and may carry an expiry",
  )
  .option(
    "--rule-pack <path>",
    "load an external RulePack (repeatable). It is executable code and is not sandboxed",
    (value: string, previous: string[] = []) => [...previous, value],
  )
  .option(
    "--fail-on <severity>",
    `exit with code 1 if any finding meets or exceeds this severity (${SCAN_FAIL_ON.join(" | ")})`,
  )
  .option(
    "--risk-index <file>",
    "also write a FairUX Risk Index for this scan to a file. It never changes stdout or the exit code",
  )
  .option(
    "--risk-index-model <version>",
    `which model scores it: ${RISK_INDEX_MODEL_VERSIONS.join(" | ")} (default ${DEFAULT_RISK_INDEX_MODEL_VERSION}). ` +
      "Two scores are comparable only when their versions match",
  )
  .option("--fix-dry-run", "report which remediations would apply, and change nothing")
  .option(
    "--fix-write",
    "apply safe remediations. Never applies a review-required one, and there is no flag that does",
  )
  .action(async (path: string, options: ScanCliOptions, command: Command) => {
    // One validator, before filesystem discovery, before a scan, before a RulePack is imported, and
    // before any output is opened. It answers for both kinds of wrong invocation: a flag whose
    // argument is not a thing, and a flag this run would accept and then ignore.
    const refusal = validateScanOptions({
      format: options.format,
      // Commander supplies `markdown` when nobody typed `--format`, and the value alone cannot tell
      // the two apart. `--write-baseline` emits no report, so refusing a default would refuse the
      // ordinary way to write a baseline.
      formatExplicit: command.getOptionValueSource("format") === "cli",
      failOn: options.failOn,
      baseline: options.baseline,
      writeBaseline: options.writeBaseline,
      suppress: options.suppress,
      riskIndex: options.riskIndex,
      riskIndexModel: options.riskIndexModel,
      fixDryRun: options.fixDryRun,
      fixWrite: options.fixWrite,
      config: options.config,
      ignoreConfig: options.ignoreConfig,
      isStdin: path === "-",
    });
    if (refusal) {
      process.stderr.write(`fairux: ${refusal}\n`);
      process.exitCode = 2;
      return;
    }
    // Every file this run will write, and every file a user named for it to read.
    //
    // Checked in stages, as each path becomes knowable — flags here, the discovered config and
    // ignore file once discovery has run, the scanned files once a glob has been expanded. All of
    // them before any output is opened, which is the point: the write that destroys something is
    // always the first one.
    const writeTargets: PathRole[] = [];
    if (options.writeBaseline) {
      writeTargets.push({ path: options.writeBaseline, label: "--write-baseline" });
    }
    if (options.riskIndex) writeTargets.push({ path: options.riskIndex, label: "--risk-index" });
    const namedReads: PathRole[] = [];
    if (options.config) namedReads.push({ path: options.config, label: "--config" });
    if (options.suppress) namedReads.push({ path: options.suppress, label: "--suppress" });
    if (options.baseline) namedReads.push({ path: options.baseline, label: "--baseline" });
    for (const pack of options.rulePack ?? []) {
      namedReads.push({ path: pack, label: "--rule-pack" });
    }

    /**
     * Refuse, and say which two paths are the same file. False means the run is over.
     *
     * Called more than once because the inputs arrive in stages: a flag names its file immediately,
     * a discovered config and `.fairuxignore` are known once discovery has run, and a directory or
     * glob only names its files once it has been expanded. Each stage is checked as soon as it is
     * knowable, so the earliest possible refusal is the one a user gets.
     */
    const refuseCollisions = (reads: readonly PathRole[]): boolean => {
      try {
        assertNoOutputCollisions(reads, writeTargets);
        return true;
      } catch (error) {
        if (!(error instanceof OutputCollisionError)) throw error;
        process.stderr.write(`fairux: ${sanitizeForTerminal(error.message)}\n`);
        process.exitCode = 2;
        return false;
      }
    };

    if (!refuseCollisions(namedReads)) return;

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
      // Discovered from the same base the config is, and never applied to an explicitly named file:
      // naming a file is an instruction, and silently doing nothing in response to a direct
      // instruction is the failure this feature most risks.
      const ignore = options.ignore ? loadIgnoreFile(configBasePath) : noIgnore(configBasePath);

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

      // Neither was named on the command line, and both would be destroyed just as completely.
      const discoveredReads: PathRole[] = [];
      if (resolvedConfig.configPath && !options.config) {
        discoveredReads.push({ path: resolvedConfig.configPath, label: "the discovered config" });
      }
      if (ignore.filePath) {
        discoveredReads.push({ path: ignore.filePath, label: "the discovered .fairuxignore" });
      }
      if (!refuseCollisions(discoveredReads)) return;

      /**
       * Load the rule packs and settle the scan options.
       *
       * Deliberately not called yet. A RulePack is unsandboxed code that runs with the user's
       * privileges, so an invocation that is going to be refused must be refused *first* — and the
       * refusal that matters most, an output that would destroy a scanned file, is only knowable
       * once the target has been expanded. Composed before any input is read, so a malformed pack or
       * a rule id colliding with a built-in one is still a refusal rather than a half-finished scan.
       */
      const loadScanOptions = async () => {
        const includeExperimental =
          options.includeExperimental || config?.includeExperimental || false;
        const { packs } = await composeRulePacksForRun(options.rulePack, includeExperimental);
        return {
          packs,
          scanOpts: {
            format: options.format as OutputFormat,
            includeExperimental,
            toolVersion: VERSION,
            config,
            rulePacks: packs,
          },
        };
      };

      /**
       * One place where a report becomes output, so the baseline cannot apply to some paths and not
       * others — stdin, a single file, and a batch all go through here.
       *
       * `--write-baseline` records the scan instead of reporting it, and deliberately does not also
       * emit a report: a command that both wrote a baseline and passed would be a command that
       * never fails, and rewriting the file during a normal scan is the same mistake.
       */
      const emit = <T extends Parameters<typeof shouldFailOn>[0]>(
        report: T,
        render: (report: T, extras: { riskIndex?: RiskIndexReport }) => string,
      ): void => {
        if (options.writeBaseline) {
          const baseline = createBaseline(report, { toolVersion: VERSION });
          writeBaseline(options.writeBaseline, baseline);
          process.stderr.write(
            `fairux: wrote ${baseline.entries.length} finding(s) to ` +
              `"${sanitizeForTerminal(options.writeBaseline)}" — accepted risk, not resolved risk\n`,
          );
          return;
        }

        let emitted = report;
        if (options.suppress) {
          // Before the baseline, so a finding covered by both is attributed to the argued one: a
          // suppression carries a reason and a baseline does not, and the reason is what a reader
          // needs. The counts stay honest either way, because each pass reports its own.
          const today = new Date().toISOString().slice(0, 10);
          const application = applySuppressions(emitted, readSuppressions(options.suppress), today);
          emitted = application.report;
          process.stderr.write(
            describeSuppressionApplication(application, sanitizeForTerminal(options.suppress)),
          );
        }
        if (options.baseline) {
          // Two different reports, deliberately. The baseline subtracts from what the suppressions
          // left — `emitted`, or a finding only the suppression file named comes back through this
          // branch — and it decides which of its entries are stale against `report`, which is what
          // reached this function before either file was read. A finding the suppression file hid
          // is hidden, not gone, and an entry covering it is not one the baseline can drop.
          //
          // `report` is not everything the scan found: inline directives are applied inside
          // `scan()` and leave no fingerprint behind. An entry covering one of those is still
          // reported as stale, which this argument does not address.
          const application = applyBaseline(emitted, readBaseline(options.baseline), report);
          emitted = application.report;
          // Always, even when nothing was suppressed: a reader cannot tell "the baseline is empty"
          // from "the baseline was not applied" unless both are reported.
          process.stderr.write(
            describeBaselineApplication(application, sanitizeForTerminal(options.baseline)),
          );
        }

        // Computed before rendering only because the HTML report shows it; every other format
        // ignores the extras entirely, so no output moves for a caller who did not ask.
        const index = options.riskIndex
          ? buildRiskIndex(emitted, VERSION, options.riskIndexModel)
          : undefined;
        const output = render(emitted, index ? { riskIndex: index } : {});
        process.stdout.write(output.endsWith("\n") ? output : `${output}\n`);
        if (options.riskIndex && index) {
          // To a file rather than to stdout. A score appearing in the output a pipeline already
          // parses would arrive in every pipeline; here it arrives only where someone asked for it.
          writeRiskIndex(options.riskIndex, index);
          process.stderr.write(describeRiskIndex(index, sanitizeForTerminal(options.riskIndex)));
        }
        if (options.fixDryRun || options.fixWrite) {
          // One plan, whether or not it is written. The dry run and the write differ in exactly one
          // branch, so what a user was shown is what a user gets.
          const plan = planFixes(emitted);
          const outcome = options.fixWrite ? writeFixes(plan) : undefined;
          process.stderr.write(describeFixPlan(plan, outcome));
          // A write that was asked for and did not happen is a failure, not a quiet no-op: a script
          // that ran `--fix-write` and saw 0 would otherwise commit a tree it believes was fixed.
          if (outcome && !outcome.ok) process.exitCode = 1;
        }
        // Against the subtracted report, so the threshold and the output cannot disagree. The risk
        // index is deliberately not consulted: a build goes red because of what was found, never
        // because a number crossed a line. Neither is a remediation: whether a fix was available
        // says nothing about whether the finding should fail the build.
        if (options.failOn && shouldFailOn(emitted, options.failOn as FailOnSeverity)) {
          process.exitCode = 1;
        }
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
        // No scanned file path to collide with, so every read this run has was already checked.
        const { packs, scanOpts } = await loadScanOptions();
        emit(scanSourceReport(source, "stdin.html", scanOpts), (report, extras) =>
          renderReport(report, options.format as OutputFormat, packs, extras),
        );
        return;
      }

      const targetPath = resolvedTarget ?? resolve(path);
      const filesToScan: string[] = [];

      if (isGlob) {
        filesToScan.push(...expandGlob(globPattern, ignore));
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
                // Pruned rather than filtered per file: an excluded directory is not descended
                // into, so a large `dist/` costs nothing to skip.
                if (ignore.ignores(full, true)) continue;
                walk(full, depth + 1);
              } else if (
                entry.isFile() &&
                (isScannableExtension(extname(full)) || isFigmaFile(full)) &&
                !ignore.ignores(full)
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

      // Reported after the walk, on stderr so machine-readable stdout stays parseable, and only
      // when there is something to report. A pattern that matches nothing is usually a typo or a
      // path that moved, and silently accepting it is how an ignore file stops doing its job
      // without anyone noticing.
      const unused = ignore.unusedPatterns();
      if (unused.length > 0 && ignore.filePath) {
        process.stderr.write(
          `fairux: ${unused.length} pattern(s) in "${sanitizeForTerminal(ignore.filePath)}" ` +
            `matched nothing: ${unused.map((pattern) => sanitizeForTerminal(pattern)).join(", ")}\n`,
        );
      }

      if (filesToScan.length === 0) {
        // Naming the ignore file here is the difference between "there is nothing to scan" and
        // "you excluded everything", which are the same message otherwise.
        const because = ignore.filePath
          ? ` ("${sanitizeForTerminal(ignore.filePath)}" was applied; use --no-ignore to bypass it)`
          : "";
        process.stderr.write(`fairux: no scannable files found${because}\n`);
        process.exitCode = 1;
        return;
      }

      // The last set to become knowable: a directory or a glob names its files only once expanded.
      // Still before any of them is read, so a refusal here costs a walk and destroys nothing.
      if (
        !refuseCollisions(
          filesToScan.map((file) => ({
            path: file,
            label: filesToScan.length === 1 ? "the scanned file" : "one of the scanned files",
          })),
        )
      ) {
        return;
      }

      const singleFile = filesToScan[0];
      if (!singleFile) {
        process.stderr.write("fairux: no scannable files found\n");
        process.exitCode = 1;
        return;
      }

      // All scanned paths are now known and have been checked against every output. Rule packs have
      // not run yet; an explicitly named executable config may already have run as trusted code.
      // No output has been opened.
      const { packs, scanOpts } = await loadScanOptions();
      const singleReportPath = toStableReportPath(singleFile);
      const isBatch = filesToScan.length > 1;
      if (isBatch) {
        emit(scanFilesReport(filesToScan, scanOpts), (report, extras) =>
          renderBatchReport(report, options.format as OutputFormat, packs, extras),
        );
      } else {
        emit(
          scanFileReport(singleFile, { ...scanOpts, reportPath: singleReportPath }),
          (report, extras) => renderReport(report, options.format as OutputFormat, packs, extras),
        );
      }
    } catch (error) {
      process.stderr.write(`fairux: ${formatTerminalError(error)}\n`);
      process.exitCode = 1;
    }
  });

interface ScanJourneyCliOptions {
  format: string;
  includeExperimental?: boolean;
  config?: string;
  ignoreConfig: boolean;
  failOn?: string;
  rulePack?: string[];
}

/**
 * `fairux scan-journey <file>` — scan an ordered flow named by a journey file.
 *
 * A separate command, never a flag on `scan`. A command that scanned one page or a whole flow
 * depending on whether an option was present would make its exit code, its report shape, and
 * `--fail-on` mean two different things, and the argument form is the part a user cannot migrate
 * away from later.
 *
 * It reads files and nothing else: no browser, no navigation, no fetch. The flow was captured by
 * whatever produced it, and the journey file names what came out.
 */
program
  .command("scan-journey")
  .argument("<file>", "path to a journey file (JSON) naming the documents of an ordered flow")
  .description("scan an ordered flow of documents already on disk. Never launches a browser")
  .option("-f, --format <format>", "output format: json | markdown", "markdown")
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
    "exit with code 1 if any finding — the flow's own or any step's — meets or exceeds this severity",
  )
  .action(async (file: string, options: ScanJourneyCliOptions) => {
    const refusal = JOURNEY_FORMAT_REFUSALS[options.format];
    if (refusal) {
      process.stderr.write(`fairux: a journey has no ${options.format} output yet — ${refusal}\n`);
      process.exitCode = 2;
      return;
    }
    if (!VALID_JOURNEY_FORMATS.has(options.format)) {
      process.stderr.write(
        `fairux: unknown format "${sanitizeForTerminal(options.format)}" (use json or markdown)\n`,
      );
      process.exitCode = 2;
      return;
    }
    if (options.failOn && !VALID_FAIL_ON.has(options.failOn)) {
      process.stderr.write(
        `fairux: unknown --fail-on severity "${sanitizeForTerminal(options.failOn)}" ` +
          `(use high, medium, low, or info)\n`,
      );
      process.exitCode = 2;
      return;
    }

    const journeyPath = resolve(file);
    if (!existsSync(journeyPath) || !statSync(journeyPath).isFile()) {
      process.stderr.write(`fairux: journey file not found: ${sanitizeForTerminal(file)}\n`);
      process.exitCode = 2;
      return;
    }

    try {
      // From the journey file's directory, so a flow moved between checkouts keeps the config its
      // steps sit beside rather than the one the caller's shell happened to be in.
      const resolved = await resolveEffectiveConfig({
        explicitPath: options.config,
        ignoreConfig: options.ignoreConfig,
        basePath: dirname(journeyPath),
      });
      if (!resolved.ok) {
        process.exitCode = 1;
        return;
      }

      const { packs } = await composeRulePacksForRun(
        options.rulePack,
        options.includeExperimental ?? resolved.config?.includeExperimental ?? false,
      );

      const journey = parseJourneyFile(
        readUtf8FileBounded(journeyPath, MAX_INPUT_BYTES).source,
        journeyPath,
      );
      const report = scanJourneyReport(journey.steps, {
        format: "json",
        ...(options.includeExperimental !== undefined
          ? { includeExperimental: options.includeExperimental }
          : {}),
        ...(resolved.config ? { config: resolved.config } : {}),
        rulePacks: packs,
        toolVersion: VERSION,
      });

      const output =
        options.format === "json"
          ? `${JSON.stringify(report, null, 2)}\n`
          : toJourneyMarkdown(report);
      process.stdout.write(output);

      if (options.failOn && shouldFailOnJourney(report, options.failOn as FailOnSeverity)) {
        process.exitCode = 1;
      }
    } catch (error) {
      const prefix = error instanceof JourneyFileError ? `journey file ` : "";
      process.stderr.write(`fairux: ${prefix}${sanitizeForTerminal(formatTerminalError(error))}\n`);
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
  .option(
    "--runtime <runtime>",
    "mark rules an input of this kind cannot run at all: html | dom | ast | figma",
  )
  .action(async (options: RulesCliOptions) => {
    if (!VALID_RULES_FORMATS.has(options.format)) {
      process.stderr.write(`fairux: unknown format "${options.format}" (use text or json)\n`);
      process.exitCode = 2;
      return;
    }
    if (options.runtime !== undefined && !isRuntime(options.runtime)) {
      process.stderr.write(
        `fairux: unknown runtime "${options.runtime}" (use ${[...VALID_RUNTIMES].join(", ")})\n`,
      );
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
        ...(options.runtime && isRuntime(options.runtime) ? { runtime: options.runtime } : {}),
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
