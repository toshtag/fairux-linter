import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { type ScanOptionState, validateScanOptions } from "../src/scan-options.js";

/**
 * The option compatibility contract, as a table.
 *
 * Two kinds of wrong invocation are refused here, and only the first used to be. A flag whose
 * argument is not a thing — `--format yaml` — already exited 2. A flag the run accepts and then
 * ignores did not: `--risk-index-model` without `--risk-index` computed no index and said nothing,
 * and `--write-baseline` returned before the suppression, baseline, index, fix, and `--fail-on`
 * branches, so a command line carrying all of them exited 0 having acted on one of them.
 *
 * The negative cases run the built CLI as well as the pure validator, because the point of the
 * change is *when* the refusal happens: before discovery, before a scan, before a RulePack is
 * imported, and before any output file is opened. A unit test alone cannot see the ordering.
 */

const here = dirname(fileURLToPath(import.meta.url));
const cliBin = resolve(here, "../dist/index.js");

const BASE: ScanOptionState = {
  format: "markdown",
  formatExplicit: false,
  isStdin: false,
};

const state = (overrides: Partial<ScanOptionState>): ScanOptionState => ({
  ...BASE,
  ...overrides,
});

interface Case {
  readonly name: string;
  readonly options: Partial<ScanOptionState>;
  /** Command-line form of the same invocation, for the end-to-end half. */
  readonly argv: readonly string[];
  /** A distinctive fragment of the refusal. */
  readonly says: string;
}

const REFUSED: readonly Case[] = [
  {
    name: "--fix-dry-run with --fix-write",
    options: { fixDryRun: true, fixWrite: true },
    argv: ["--fix-dry-run", "--fix-write"],
    says: "ask for opposite things",
  },
  {
    name: "--risk-index-model without --risk-index",
    options: { riskIndexModel: "fairux-risk/2" },
    argv: ["--risk-index-model", "fairux-risk/2"],
    says: "--risk-index-model has no effect without --risk-index",
  },
  {
    name: "--write-baseline with --baseline",
    options: { writeBaseline: "out.json", baseline: "b.json" },
    argv: ["--write-baseline", "out.json", "--baseline", "b.json"],
    says: "--write-baseline ignores --baseline",
  },
  {
    name: "--write-baseline with --suppress",
    options: { writeBaseline: "out.json", suppress: "s.json" },
    argv: ["--write-baseline", "out.json", "--suppress", "s.json"],
    says: "--write-baseline ignores --suppress",
  },
  {
    name: "--write-baseline with --risk-index",
    options: { writeBaseline: "out.json", riskIndex: "i.json" },
    argv: ["--write-baseline", "out.json", "--risk-index", "i.json"],
    says: "--write-baseline ignores --risk-index",
  },
  {
    name: "--write-baseline with --fix-write",
    options: { writeBaseline: "out.json", fixWrite: true },
    argv: ["--write-baseline", "out.json", "--fix-write"],
    says: "--write-baseline ignores --fix-write",
  },
  {
    name: "--write-baseline with --fix-dry-run",
    options: { writeBaseline: "out.json", fixDryRun: true },
    argv: ["--write-baseline", "out.json", "--fix-dry-run"],
    says: "--write-baseline ignores --fix-dry-run",
  },
  {
    name: "--write-baseline with --fail-on",
    options: { writeBaseline: "out.json", failOn: "high" },
    argv: ["--write-baseline", "out.json", "--fail-on", "high"],
    says: "--write-baseline ignores --fail-on",
  },
  {
    name: "--write-baseline with an explicit --format",
    options: { writeBaseline: "out.json", format: "json", formatExplicit: true },
    argv: ["--write-baseline", "out.json", "--format", "json"],
    says: "--write-baseline ignores --format",
  },
  {
    name: "--config with --ignore-config",
    options: { config: "fairux.config.json", ignoreConfig: true },
    argv: ["--config", "fairux.config.json", "--ignore-config"],
    says: "--config ignores --ignore-config",
  },
  {
    name: "an unknown --format",
    options: { format: "yaml", formatExplicit: true },
    argv: ["--format", "yaml"],
    says: 'unknown format "yaml"',
  },
  {
    name: "an unknown --fail-on severity",
    options: { failOn: "critical" },
    argv: ["--fail-on", "critical"],
    says: 'unknown --fail-on severity "critical"',
  },
  {
    name: "an unknown --risk-index-model",
    options: { riskIndex: "i.json", riskIndexModel: "fairux-risk/9" },
    argv: ["--risk-index", "i.json", "--risk-index-model", "fairux-risk/9"],
    says: 'unknown risk index model "fairux-risk/9"',
  },
];

/**
 * Invocations that must keep working. Every one of them is a documented combination or a shape the
 * repository's own tests already run, so this half is the regression guard on the refusals above.
 */
const ACCEPTED: readonly { name: string; options: Partial<ScanOptionState> }[] = [
  { name: "no options at all", options: {} },
  { name: "--write-baseline alone, with the default format", options: { writeBaseline: "b.json" } },
  {
    name: "--suppress and --baseline together",
    options: { suppress: "s.json", baseline: "b.json" },
  },
  {
    name: "--suppress, --baseline, --fail-on, and --risk-index together",
    options: {
      suppress: "s.json",
      baseline: "b.json",
      failOn: "high",
      riskIndex: "i.json",
      riskIndexModel: "fairux-risk/2",
    },
  },
  { name: "--fix-dry-run on a file", options: { fixDryRun: true } },
  { name: "--fix-write on a file", options: { fixWrite: true } },
  { name: "--ignore-config without --config", options: { ignoreConfig: true } },
  { name: "--config without --ignore-config", options: { config: "c.json" } },
  {
    name: "an explicit --format with --risk-index",
    options: { format: "json", formatExplicit: true, riskIndex: "i.json" },
  },
  {
    name: "stdin without a fix flag",
    options: { isStdin: true, format: "json", formatExplicit: true },
  },
];

describe("scan option compatibility (validator)", () => {
  for (const scenario of REFUSED) {
    it(`refuses ${scenario.name}`, () => {
      expect(validateScanOptions(state(scenario.options))).toContain(scenario.says);
    });
  }

  for (const scenario of ACCEPTED) {
    it(`accepts ${scenario.name}`, () => {
      expect(validateScanOptions(state(scenario.options))).toBeUndefined();
    });
  }

  it("refuses a fix flag on stdin, where there is no source path to write back to", () => {
    expect(validateScanOptions(state({ isStdin: true, fixWrite: true }))).toContain(
      "need a filesystem input",
    );
    expect(validateScanOptions(state({ isStdin: true, fixDryRun: true }))).toContain(
      "need a filesystem input",
    );
  });

  it("names every ignored flag in one message, not one per rerun", () => {
    const message = validateScanOptions(
      state({ writeBaseline: "out.json", suppress: "s.json", baseline: "b.json", failOn: "high" }),
    );
    expect(message).toContain("--suppress");
    expect(message).toContain("--baseline");
    expect(message).toContain("--fail-on");
  });

  it("does not refuse the default --format nobody typed", () => {
    // Commander supplies `markdown`. Refusing it would refuse the ordinary way to write a baseline.
    expect(
      validateScanOptions(state({ writeBaseline: "b.json", format: "markdown" })),
    ).toBeUndefined();
  });

  it("sanitises a value it quotes back to the terminal", () => {
    const message = validateScanOptions(state({ format: "json\u001b[2J", formatExplicit: true }));
    expect(message).toBeDefined();
    expect(message).not.toContain("\u001b");
  });
});

const PAGE = '<main><label><input type="checkbox" checked> Email me offers</label></main>';

function withTempDir<T>(body: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "fairux-scan-options-"));
  try {
    return body(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("scan option compatibility (built CLI)", () => {
  for (const scenario of REFUSED) {
    it(`exits 2 and writes nothing for ${scenario.name}`, () => {
      withTempDir((dir) => {
        writeFileSync(join(dir, "page.html"), PAGE, "utf8");
        const result = spawnSync(
          "node",
          [cliBin, "scan", "page.html", "--ignore-config", ...scenario.argv],
          { encoding: "utf8", cwd: dir, timeout: 20000 },
        );
        expect(result.status, result.stderr).toBe(2);
        expect(result.stderr).toContain(scenario.says);
        expect(result.stdout).toBe("");
        // The refusal is before any output is opened, so nothing this run could have written is
        // there. An exit code alone would pass against a check that ran after the write.
        expect(readdirSync(dir).sort()).toEqual(["page.html"]);
      });
    });
  }

  it("refuses before a RulePack is imported, which runs as unsandboxed code", () => {
    withTempDir((dir) => {
      writeFileSync(join(dir, "page.html"), PAGE, "utf8");
      const pack = join(dir, "pack.mjs");
      // Importing this pack writes a file. If the file is absent afterwards, the refusal came first.
      writeFileSync(
        pack,
        [
          'import { writeFileSync } from "node:fs";',
          'writeFileSync(new URL("./imported.txt", import.meta.url), "yes");',
          "export default { id: 'evidence', rules: [] };",
        ].join("\n"),
        "utf8",
      );
      const result = spawnSync(
        "node",
        [
          cliBin,
          "scan",
          "page.html",
          "--ignore-config",
          "--rule-pack",
          pack,
          "--write-baseline",
          "out.json",
          "--fail-on",
          "high",
        ],
        { encoding: "utf8", cwd: dir, timeout: 20000 },
      );
      expect(result.status, result.stderr).toBe(2);
      expect(readdirSync(dir).sort()).toEqual(["pack.mjs", "page.html"]);
    });
  });
});
