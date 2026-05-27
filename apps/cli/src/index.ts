import { Command } from "commander";
import { type OutputFormat, scanFile } from "./scan-file.js";

const VERSION = "0.1.0";

const program = new Command();

program
  .name("fairux")
  .description("Detect UI patterns that may distort user decision-making (UX risk signals).")
  .version(VERSION);

program
  .command("scan")
  .argument("<path>", "path to a static HTML file")
  .option("-f, --format <format>", "output format: json | markdown", "markdown")
  .option("--include-experimental", "also run experimental (heuristic) rules", false)
  .action((path: string, options: { format: string; includeExperimental: boolean }) => {
    if (options.format !== "json" && options.format !== "markdown") {
      process.stderr.write(`fairux: unknown format "${options.format}" (use json or markdown)\n`);
      process.exitCode = 2;
      return;
    }
    try {
      const output = scanFile(path, {
        format: options.format as OutputFormat,
        includeExperimental: options.includeExperimental,
        toolVersion: VERSION,
      });
      process.stdout.write(output.endsWith("\n") ? output : `${output}\n`);
    } catch (error) {
      process.stderr.write(`fairux: ${(error as Error).message}\n`);
      process.exitCode = 1;
    }
  });

program.parse();
