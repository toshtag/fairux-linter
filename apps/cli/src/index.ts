import { resolve } from "node:path";
import type { FairuxConfig } from "@fairux/core";
import { Command } from "commander";
import { discoverConfig, loadConfig, parseJsonConfig, sanitizeForTerminal } from "./load-config.js";
import { type OutputFormat, scanFile } from "./scan-file.js";

const VERSION = "0.3.0";

const VALID_FORMATS: ReadonlySet<string> = new Set(["json", "markdown", "sarif"]);

interface ScanCliOptions {
  format: string;
  includeExperimental: boolean;
  config?: string;
  ignoreConfig: boolean;
}

const program = new Command();

program
  .name("fairux")
  .description("Detect UI patterns that may distort user decision-making (UX risk signals).")
  .version(VERSION);

program
  .command("scan")
  .argument("<path>", "path to a static HTML file")
  .option("-f, --format <format>", "output format: json | markdown | sarif", "markdown")
  .option("--include-experimental", "also run experimental (heuristic) rules", false)
  .option(
    "--config <path>",
    "path to a fairux.config file (.json, or executable .ts/.mjs/.js/.cjs you trust); " +
      "when omitted, only fairux.config.json is auto-discovered",
  )
  .option("--ignore-config", "skip automatic config discovery", false)
  .action(async (path: string, options: ScanCliOptions) => {
    if (!VALID_FORMATS.has(options.format)) {
      process.stderr.write(
        `fairux: unknown format "${options.format}" (use json, markdown, or sarif)\n`,
      );
      process.exitCode = 2;
      return;
    }
    try {
      let config: FairuxConfig | undefined;
      if (options.config) {
        // Explicit --config is the only path that may execute code. loadConfig warns (via
        // onBeforeExecute) right before importing, so a user pointing fairux at an untrusted
        // repo's config knows they're running it. Paths are sanitized for terminal safety.
        config = await loadConfig(options.config, {
          allowExecutable: true,
          onBeforeExecute: (p) =>
            process.stderr.write(
              `fairux: executing config "${sanitizeForTerminal(p)}" as trusted code — it runs ` +
                `with your privileges. Only do this for configs you trust.\n`,
            ),
        });
      } else if (!options.ignoreConfig) {
        // Auto-discovery only ever finds fairux.config.json (data, never executed), so scanning an
        // untrusted repo can't run code it ships. discoverConfig() returns diagnostics for every
        // skipped/unsafe config so nothing is silently ignored. See load-config.ts security model.
        const { configPath, contents, diagnostics } = discoverConfig(resolve(path));
        for (const d of diagnostics) {
          const safePath = sanitizeForTerminal(d.path);
          const line =
            d.level === "error"
              ? `refusing auto-discovered config "${safePath}": ${d.message}`
              : `found "${safePath}" — ${d.message}`;
          process.stderr.write(`fairux: ${line}\n`);
        }
        // Fail closed: an existing-but-unsafe nearest config is an error, not a fallthrough.
        if (diagnostics.some((d) => d.level === "error")) {
          process.exitCode = 1;
          return;
        }
        // Parse the bytes discovery already vetted (not a re-read of the path) — closes TOCTOU.
        if (configPath && contents !== undefined) config = parseJsonConfig(contents, configPath);
      }
      const output = scanFile(path, {
        format: options.format as OutputFormat,
        includeExperimental: options.includeExperimental,
        toolVersion: VERSION,
        config,
      });
      process.stdout.write(output.endsWith("\n") ? output : `${output}\n`);
    } catch (error) {
      // A thrown value isn't guaranteed to be an Error (executable config could `throw "..."`), so
      // normalize before sanitizing — `sanitizeForTerminal(undefined)` would itself throw. Error
      // messages can embed user-derived paths, so sanitize at this final stderr sink too.
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`fairux: ${sanitizeForTerminal(message)}\n`);
      process.exitCode = 1;
    }
  });

program.parse();
