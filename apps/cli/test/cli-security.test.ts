import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * Security regression tests that exercise the REAL attack path: spawn the built CLI binary and
 * assert that an attacker-shipped executable config is never run via auto-discovery, but IS run
 * (with a warning) when explicitly opted into via --config. These guard the P10-T1 fix end-to-end
 * — Commander → option branch → auto-discovery → loadConfig → jiti — not just the internal helpers.
 *
 * Requires `pnpm --filter @fairux/cli build` first (the verify pipeline builds before testing).
 */

const here = dirname(fileURLToPath(import.meta.url));
const cliEntry = resolve(here, "../dist/index.js");
const hasBuild = existsSync(cliEntry);

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

describe.skipIf(!hasBuild)("CLI security (real process)", () => {
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
    // It should warn that it found-but-skipped the executable config.
    expect(res.stderr).toMatch(/did not load it automatically/i);
    // stdout must remain valid JSON — the warning went to stderr, not stdout.
    expect(() => JSON.parse(res.stdout)).not.toThrow();
  });

  it("DOES execute an explicit --config, and warns first", () => {
    const res = runCli(["scan", page, "--config", maliciousTs, "--format", "json"]);
    expect(res.status).toBe(0);
    expect(existsSync(marker)).toBe(true); // explicit opt-in runs it
    expect(res.stderr).toMatch(/trusted code/i);
    expect(() => JSON.parse(res.stdout)).not.toThrow();
  });

  it("--ignore-config skips discovery entirely (no warning, no execution)", () => {
    const res = runCli(["scan", page, "--ignore-config", "--format", "json"]);
    expect(res.status).toBe(0);
    expect(existsSync(marker)).toBe(false);
    expect(res.stderr).not.toMatch(/did not load|trusted code/i);
  });
});
