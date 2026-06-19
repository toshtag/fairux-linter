import { dirname, resolve } from "node:path";
import type { FairuxConfig } from "@fairux/core";
import { Command } from "commander";
import { findConfigFile, loadConfig, sanitizeForTerminal } from "./load-config.js";
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
        // untrusted repo can't run code it ships. If it passes an executable fairux.config.* it
        // warns rather than silently ignoring it. See load-config.ts security model.
        const auto = findConfigFile(dirname(resolve(path)), (skipped) =>
          process.stderr.write(
            `fairux: found "${sanitizeForTerminal(skipped)}" but did not load it automatically — ` +
              `executable config is trusted code. Pass --config <path> to opt in, or convert it ` +
              `to fairux.config.json.\n`,
          ),
        );
        if (auto) config = await loadConfig(auto);
      }
      const output = scanFile(path, {
        format: options.format as OutputFormat,
        includeExperimental: options.includeExperimental,
        toolVersion: VERSION,
        config,
      });
      process.stdout.write(output.endsWith("\n") ? output : `${output}\n`);
    } catch (error) {
      process.stderr.write(`fairux: ${(error as Error).message}\n`);
      process.exitCode = 1;
    }
  });

program.parse();
