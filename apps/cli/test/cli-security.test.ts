import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * Security regression tests that exercise the REAL attack path: spawn the built CLI binary and
 * assert the P10-T1 guarantees end-to-end — Commander → option branch → auto-discovery → loadConfig
 * → jiti — not just the internal helpers.
 *
 * These tests REQUIRE a fresh CLI build. They do NOT `skipIf` a missing/stale build: a silently
 * skipped security test reads as "passed". `pnpm test:cli-security` builds first; the verify
 * pipeline also builds before testing. If the build is missing we fail loudly here instead.
 */

const here = dirname(fileURLToPath(import.meta.url));
const cliEntry = resolve(here, "../dist/index.js");

if (!existsSync(cliEntry)) {
  throw new Error(
    `CLI security tests require a fresh build at ${cliEntry}. ` +
      `Run "pnpm --filter @fairux/cli build" (or "pnpm test:cli-security") first.`,
  );
}

interface CliResult {
  status: number;
  stdout: string;
  stderr: string;
}

function runCli(args: string[], cwd?: string): CliResult {
  // spawnSync (not execFileSync) so we capture stdout AND stderr on success — the trust warning
  // goes to stderr even when the scan exits 0.
  const res = spawnSync("node", [cliEntry, ...args], { cwd, encoding: "utf8" });
  return { status: res.status ?? 1, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

describe("CLI security (real process)", () => {
  let dir: string;
  let marker: string;
  let page: string;
  let maliciousTs: string;

  beforeEach(() => {
    dir = mkdtempSync(resolve(tmpdir(), "fairux-sec-"));
    mkdirSync(resolve(dir, ".git")); // make `dir` the discovery boundary
    marker = resolve(dir, "EXECUTED_MARKER");
    page = resolve(dir, "page.html");
    writeFileSync(page, "<html><body><button>OK</button></body></html>", "utf8");
    maliciousTs = resolve(dir, "fairux.config.ts");
    writeFileSync(
      maliciousTs,
      `import { writeFileSync } from "node:fs";\n` +
        // Print a marker to stderr so a test can assert the warning is printed BEFORE execution.
        `process.stderr.write("CONFIG_EXECUTED\\n");\n` +
        `writeFileSync(${JSON.stringify(marker)}, "executed");\n` +
        `export default {};\n`,
      "utf8",
    );
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("does NOT execute an auto-discovered fairux.config.ts (no code runs)", () => {
    const res = runCli(["scan", page, "--format", "json"]);
    expect(res.status).toBe(0);
    expect(existsSync(marker)).toBe(false); // the malicious side effect never happened
    expect(res.stderr).toMatch(/did not load it automatically/i);
    expect(() => JSON.parse(res.stdout)).not.toThrow(); // warning went to stderr, stdout stays JSON
  });

  it("DOES execute an explicit --config, and warns BEFORE executing", () => {
    const res = runCli(["scan", page, "--config", maliciousTs, "--format", "json"]);
    expect(res.status).toBe(0);
    expect(existsSync(marker)).toBe(true); // explicit opt-in runs it
    // The trust warning must precede the config's own side effect, not follow it.
    const warnAt = res.stderr.indexOf("executing config");
    const execAt = res.stderr.indexOf("CONFIG_EXECUTED");
    expect(warnAt).toBeGreaterThanOrEqual(0);
    expect(execAt).toBeGreaterThanOrEqual(0);
    expect(warnAt).toBeLessThan(execAt);
    expect(() => JSON.parse(res.stdout)).not.toThrow();
  });

  it("--ignore-config skips discovery entirely (no warning, no execution)", () => {
    const res = runCli(["scan", page, "--ignore-config", "--format", "json"]);
    expect(res.status).toBe(0);
    expect(existsSync(marker)).toBe(false);
    expect(res.stderr).not.toMatch(/did not load|trusted code/i);
  });

  describe("--ignore-config isolates from a JSON config (policy integrity)", () => {
    let consentPage: string;
    const RULE = "consent/missing-reject-option";

    beforeEach(() => {
      // A consent banner with an accept button and NO reject option triggers RULE.
      consentPage = resolve(dir, "consent.html");
      writeFileSync(
        consentPage,
        `<html><body><div role="dialog"><p>We use cookies.</p>` +
          `<button>Accept</button></div></body></html>`,
        "utf8",
      );
    });

    function ruleIds(stdout: string): string[] {
      return (JSON.parse(stdout).findings as Array<{ ruleId: string }>).map((f) => f.ruleId);
    }

    it("a JSON config disabling a rule applies normally, but --ignore-config keeps the finding", () => {
      writeFileSync(
        resolve(dir, "fairux.config.json"),
        JSON.stringify({ rules: { [RULE]: false } }),
        "utf8",
      );
      // Sanity: without config tampering, the rule fires.
      const ignored = runCli(["scan", consentPage, "--ignore-config", "--format", "json"]);
      expect(ignored.status).toBe(0);
      expect(ruleIds(ignored.stdout)).toContain(RULE);

      // With auto-discovery, the JSON disables the rule (this is the manipulation we isolate against).
      const honored = runCli(["scan", consentPage, "--format", "json"]);
      expect(honored.status).toBe(0);
      expect(ruleIds(honored.stdout)).not.toContain(RULE);
    });

    it("a malformed JSON config fails the scan, but --ignore-config still succeeds", () => {
      writeFileSync(resolve(dir, "fairux.config.json"), "{ invalid json", "utf8");
      const honored = runCli(["scan", consentPage, "--format", "json"]);
      expect(honored.status).not.toBe(0); // bad config breaks the scan...

      const ignored = runCli(["scan", consentPage, "--ignore-config", "--format", "json"]);
      expect(ignored.status).toBe(0); // ...unless we isolate from it
    });
  });
});
