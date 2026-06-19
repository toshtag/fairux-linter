import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { FairUxReport } from "@fairux/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  findConfigFile,
  isExecutableConfigPath,
  loadConfig,
  sanitizeForTerminal,
} from "../src/load-config.js";
import { scanFile } from "../src/scan-file.js";

const here = dirname(fileURLToPath(import.meta.url));
const examplePath = resolve(here, "../../../examples/consent-banner.html");

const ruleIds = (json: string): string[] =>
  (JSON.parse(json) as FairUxReport).findings.map((f) => f.ruleId);

describe("loadConfig + findConfigFile", () => {
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

  it("finds the nearest fairux.config.json upward from a directory", () => {
    const file = resolve(dir, "fairux.config.json");
    writeFileSync(file, "{}", "utf8");
    expect(findConfigFile(dir)).toBe(file);
  });

  it("does NOT auto-discover an executable config (only JSON is auto-loaded)", () => {
    // An attacker-shipped fairux.config.ts in a scanned repo must never be picked up automatically.
    writeFileSync(resolve(dir, "fairux.config.ts"), "export default {};\n", "utf8");
    expect(findConfigFile(dir)).toBeUndefined();
  });

  it("stops upward discovery at a package.json boundary (single npm package)", () => {
    // Layout: <dir>/fairux.config.json  (above the boundary)
    //         <dir>/project/package.json  (the boundary, no .git)
    //         <dir>/project/sub/         (where we start the search)
    // The config above the boundary must NOT be reached from inside the package.
    writeFileSync(resolve(dir, "fairux.config.json"), "{}", "utf8");
    const project = resolve(dir, "project");
    mkdirSync(project);
    writeFileSync(resolve(project, "package.json"), "{}", "utf8");
    const sub = resolve(project, "sub");
    mkdirSync(sub);
    expect(findConfigFile(sub)).toBeUndefined();
  });

  it("finds the REPO-ROOT config from a nested package (monorepo)", () => {
    // .git marks the repo root; a nested package.json must NOT stop discovery short of it.
    mkdirSync(resolve(dir, ".git"));
    writeFileSync(resolve(dir, "fairux.config.json"), "{}", "utf8");
    const pkg = resolve(dir, "apps/web");
    mkdirSync(pkg, { recursive: true });
    writeFileSync(resolve(pkg, "package.json"), "{}", "utf8");
    const src = resolve(pkg, "src");
    mkdirSync(src);
    expect(findConfigFile(src)).toBe(resolve(dir, "fairux.config.json"));
  });

  it("does NOT follow a symlinked config out of the project", () => {
    mkdirSync(resolve(dir, ".git"));
    writeFileSync(resolve(dir, "outside.json"), "{}", "utf8");
    symlinkSync(resolve(dir, "outside.json"), resolve(dir, "fairux.config.json"));
    expect(findConfigFile(dir)).toBeUndefined();
  });

  it("warns (does not silently ignore) an executable config seen during auto-discovery", () => {
    writeFileSync(resolve(dir, "fairux.config.ts"), "export default {};\n", "utf8");
    let skipped: string | undefined;
    expect(findConfigFile(dir, (p) => (skipped = p))).toBeUndefined();
    expect(skipped).toBe(resolve(dir, "fairux.config.ts"));
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

  it("strips control characters from paths for terminal-safe warnings", () => {
    const esc = String.fromCharCode(0x1b); // ANSI ESC
    const nl = String.fromCharCode(0x0a); // newline
    expect(sanitizeForTerminal(`a${esc}[31mb${nl}c`)).toBe("a[31mbc");
  });

  it("rejects an unsupported configVersion", async () => {
    const file = resolve(dir, "fairux.config.json");
    writeFileSync(file, JSON.stringify({ configVersion: 99 }), "utf8");
    await expect(loadConfig(file)).rejects.toThrow(/configVersion/i);
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
      JSON.stringify({ rules: { "consent/checked-checkbox": { severity: "low" } } }),
      "utf8",
    );
    const config = await loadConfig(file);
    const report = JSON.parse(scanFile(examplePath, { format: "json", config })) as FairUxReport;
    const finding = report.findings.find((f) => f.ruleId === "consent/checked-checkbox");
    expect(finding?.severity).toBe("low");
  });
});
