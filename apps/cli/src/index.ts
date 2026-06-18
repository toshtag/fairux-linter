import { dirname, resolve } from "node:path";
import type { FairuxConfig } from "@fairux/core";
import { Command } from "commander";
import { findConfigFile, loadConfig } from "./load-config.js";
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
    "path to a fairux.config file (.ts/.mjs/.js/.cjs/.json); auto-discovered if omitted",
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
        config = await loadConfig(options.config);
      } else if (!options.ignoreConfig) {
        const auto = findConfigFile(dirname(resolve(path)));
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
