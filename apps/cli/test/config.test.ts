import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { FairUxReport } from "@fairux/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findConfigFile, loadConfig } from "../src/load-config.js";
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

  it("stops upward discovery at the project root (.git / package.json marker)", () => {
    // Layout: <dir>/fairux.config.json  (above the root)
    //         <dir>/project/package.json  (the project-root marker)
    //         <dir>/project/sub/         (where we start the search)
    // The config above the root must NOT be reached from inside the project.
    writeFileSync(resolve(dir, "fairux.config.json"), "{}", "utf8");
    const project = resolve(dir, "project");
    mkdirSync(project);
    writeFileSync(resolve(project, "package.json"), "{}", "utf8");
    const sub = resolve(project, "sub");
    mkdirSync(sub);
    expect(findConfigFile(sub)).toBeUndefined();
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
