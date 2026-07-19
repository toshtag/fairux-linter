import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { FairUxReport } from "@fairux/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  formatTerminalError,
  isExecutableConfigPath,
  loadConfig,
  sanitizeForTerminal,
} from "../src/load-config.js";
import { scanFile } from "../src/scan-file.js";

const here = dirname(fileURLToPath(import.meta.url));
const cliBin = resolve(here, "../dist/index.js");
const examplePath = resolve(here, "../../../examples/consent-banner.html");

const ruleIds = (json: string): string[] =>
  (JSON.parse(json) as FairUxReport).findings.map((f) => f.ruleId);

describe("loadConfig + discoverConfig", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(resolve(tmpdir(), "fairux-cfg-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("loads a JSON config", async () => {
    const file = resolve(dir, "fairux.config.json");
    writeFileSync(
      file,
      JSON.stringify({ rules: { "consent/missing-reject-option": false } }),
      "utf8",
    );
    const cfg = await loadConfig(file);
    expect(cfg.rules?.["consent/missing-reject-option"]).toBe(false);
  });

  it("loads an .mjs config when executable loading is opted in", async () => {
    const file = resolve(dir, "fairux.config.mjs");
    writeFileSync(
      file,
      'export default { includeExperimental: true, rules: { "consent/checked-checkbox": { severity: "low" } } };\n',
      "utf8",
    );
    const cfg = await loadConfig(file, { allowExecutable: true });
    expect(cfg.includeExperimental).toBe(true);
    const override = cfg.rules?.["consent/checked-checkbox"];
    expect(typeof override).toBe("object");
    expect(override).toEqual({ severity: "low" });
  });

  it("refuses to execute a config when not opted in (untrusted-input safety)", async () => {
    const file = resolve(dir, "fairux.config.mjs");
    writeFileSync(file, "export default {};\n", "utf8");
    await expect(loadConfig(file)).rejects.toThrow(/Refusing to execute/i);
  });

  it("rejects unsupported config extensions via the allowlist", async () => {
    const file = resolve(dir, "fairux.config.yaml");
    writeFileSync(file, "rules: {}\n", "utf8");
    await expect(loadConfig(file, { allowExecutable: true })).rejects.toThrow(
      /Unsupported.*extension/i,
    );
  });

  it("classifies a .JSON (uppercase) as data, not executable", () => {
    expect(isExecutableConfigPath("fairux.config.JSON")).toBe(false);
  });

  it("classifies config extensions via a strict allowlist (no surprise executables)", () => {
    // Supported data + executable extensions.
    expect(isExecutableConfigPath("a.json")).toBe(false);
    expect(isExecutableConfigPath("a.Json")).toBe(false); // case-insensitive
    for (const ext of ["ts", "Ts", "mjs", "js", "cjs"]) {
      expect(isExecutableConfigPath(`a.${ext}`)).toBe(true);
    }
    // Anything else throws (it is NOT silently treated as executable or data).
    for (const bad of ["a.yaml", "a.toml", "fairux", "a.json.exe", "a.json~", "a."]) {
      expect(() => isExecutableConfigPath(bad)).toThrow(/Unsupported.*extension/i);
    }
  });

  it("strips control characters from paths for terminal-safe warnings", () => {
    const esc = String.fromCharCode(0x1b); // ANSI ESC
    const nl = String.fromCharCode(0x0a); // newline
    expect(sanitizeForTerminal(`a${esc}[31mb${nl}c`)).toBe("a[31mb c");
  });

  it("strips Unicode bidi controls (RLO filename-spoofing) too", () => {
    const rlo = String.fromCharCode(0x202e); // RIGHT-TO-LEFT OVERRIDE
    expect(sanitizeForTerminal(`safe${rlo}gpj.exe`)).toBe("safegpj.exe");
  });

  it("sanitizes complete terminal error messages", () => {
    const esc = String.fromCharCode(0x1b);
    const nl = "\n";
    const rlo = String.fromCharCode(0x202e);
    const result = formatTerminalError(`fairux config at bad${nl}${esc}[31m${rlo}path: invalid`);
    expect(result).not.toContain(nl);
    expect(result).not.toContain(esc);
    expect(result).not.toContain(rlo);
    expect(result).toContain("invalid");
  });

  it("sanitizes auto-discovered config validation stderr as a single terminal-safe line", () => {
    const esc = String.fromCharCode(0x1b);
    const rlo = String.fromCharCode(0x202e);
    const controlName = process.platform === "win32" ? "bad-path" : `bad\n${esc}[31m${rlo}path`;
    const project = resolve(dir, controlName);
    mkdirSync(project);
    writeFileSync(resolve(project, "fairux.config.json"), '{"unknownKey":1}', "utf8");
    const page = resolve(project, "page.html");
    writeFileSync(page, "<button>Buy now</button>", "utf8");

    const result = spawnSync("node", [cliBin, "scan", page, "--format", "json"], {
      encoding: "utf8",
      timeout: 10000,
    });

    expect(result.status).toBe(1);
    const stderr = result.stderr.trimEnd();
    expect(stderr).toContain("unknown top-level key");
    expect(stderr).not.toContain(esc);
    expect(stderr).not.toContain(rlo);
    expect(stderr).not.toContain("\n");
  });

  if (process.platform === "win32") {
    it("does not run the POSIX FIFO config regression on Windows", () => {
      expect(process.platform).toBe("win32");
    });
  } else {
    it("refuses an explicit --config that is not a regular file (e.g. a FIFO won't hang)", async () => {
      const fifo = resolve(dir, "fairux.config.json");
      execFileSync("mkfifo", [fifo]); // a failure here fails the test, by design
      // Must reject promptly on the not-a-regular-file check, never block on readFileSync.
      await expect(loadConfig(fifo)).rejects.toThrow(/not a regular file/i);
    });
  }

  it("allows an explicit --config that IS a symlink (explicit = trusted opt-in)", async () => {
    writeFileSync(resolve(dir, "real.json"), JSON.stringify({ includeExperimental: true }), "utf8");
    const link = resolve(dir, "linked.config.json");
    symlinkSync(resolve(dir, "real.json"), link);
    const cfg = await loadConfig(link);
    expect(cfg.includeExperimental).toBe(true);
  });
});

describe("scanFile with config (end-to-end)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(resolve(tmpdir(), "fairux-cfg-e2e-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("config disables a rule end-to-end", async () => {
    // Baseline: consent-banner.html triggers consent/missing-reject-option (no reject button).
    const baseline = ruleIds(scanFile(examplePath, { format: "json" }));
    expect(baseline).toContain("consent/missing-reject-option");

    const file = resolve(dir, "fairux.config.json");
    writeFileSync(
      file,
      JSON.stringify({ rules: { "consent/missing-reject-option": false } }),
      "utf8",
    );
    const config = await loadConfig(file);
    const ids = ruleIds(scanFile(examplePath, { format: "json", config }));
    expect(ids).not.toContain("consent/missing-reject-option");
  });

  it("config severity override flows into the report", async () => {
    const file = resolve(dir, "fairux.config.json");
    writeFileSync(
      file,
      JSON.stringify({
        rules: { "consent/checked-checkbox": { severity: "low" } },
      }),
      "utf8",
    );
    const config = await loadConfig(file);
    const report = JSON.parse(scanFile(examplePath, { format: "json", config })) as FairUxReport;
    const finding = report.findings.find((f) => f.ruleId === "consent/checked-checkbox");
    expect(finding?.severity).toBe("low");
  });
});
