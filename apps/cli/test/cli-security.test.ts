import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * Security regression tests that exercise the REAL attack path: spawn the built CLI binary and
 * assert the P10-T1 guarantees end-to-end — Commander → option branch → auto-discovery → loadConfig
 * → jiti — not just the internal helpers.
 *
 * These tests run the BUILT CLI, so they require `dist/index.js`. They do NOT `skipIf` it away: a
 * silently skipped security test reads as "passed", which is worse than a hard failure. If the build
 * is MISSING we throw here. We can't detect a STALE build from here, so run them via
 * `pnpm test:cli-security` (which builds the CLI and its workspace deps first); `pnpm verify` also
 * builds before `pnpm test`. Running raw `vitest` against an out-of-date `dist` tests stale code —
 * use the script.
 */

const here = dirname(fileURLToPath(import.meta.url));
const cliEntry = resolve(here, "../dist/index.js");

if (!existsSync(cliEntry)) {
  throw new Error(
    `CLI security tests require the built CLI at ${cliEntry}, and it's missing. ` +
      `Run "pnpm test:cli-security" (builds the CLI + workspace deps, then runs these), ` +
      `or "pnpm --filter '@fairux/cli...' build" first.`,
  );
}

interface CliResult {
  status: number;
  stdout: string;
  stderr: string;
}

function runCli(args: string[], cwd?: string): CliResult {
  // spawnSync so we capture stdout AND stderr on success — the trust warning goes to stderr even
  // when the scan exits 0. A hard `timeout` guards against any child-process hang regression:
  // without it a hang would block this synchronous call and Vitest's own timeout couldn't fire. A
  // timed-out run surfaces as a FAIL below.
  const res = spawnSync("node", [cliEntry, ...args], {
    cwd,
    encoding: "utf8",
    timeout: 10_000,
  });
  if (res.error && "code" in res.error && res.error.code === "ETIMEDOUT") {
    throw new Error(`CLI hung (ETIMEDOUT) for args: ${args.join(" ")}`);
  }
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

  // The CLI must resolve the scan target ONCE and use the same resolved path for config discovery,
  // adapter selection, AND the actual read — so a `symlink/../file` input can't make it vet one path
  // while the read opens another. Layout: `jump -> outside/sub`, so the input
  // `dir/jump/../page.html` lexically resolves to `dir/page.html` (the safe in-repo file, which
  // triggers NO rules), whereas OS-following `jump/..` would land in `outside/` (whose page.html has
  // a scarcity phrase → a finding). A clean (zero-finding) report proves the in-repo file was read.
  describe("scan target is resolved once (no lexical-vs-OS path mismatch)", () => {
    let trusted: string;
    let input: string;
    beforeEach(() => {
      writeFileSync(page, "<html><body><p>Welcome to our site.</p></body></html>", "utf8"); // no rules
      mkdirSync(resolve(dir, "outside", "sub"), { recursive: true });
      writeFileSync(
        resolve(dir, "outside", "page.html"),
        "<html><body><p>Only 2 left! Hurry, limited time offer ends soon!</p></body></html>",
        "utf8",
      );
      symlinkSync(resolve(dir, "outside", "sub"), resolve(dir, "jump"));
      // Pass an UNNORMALIZED RELATIVE path (run with cwd=dir). resolve() in the test would have
      // collapsed `jump/..` before the CLI ever saw it; we want the literal `jump/../page.html`
      // string to reach the process. OS-following `jump/..` lands in outside/ (a scarcity finding);
      // lexical resolve()/normalize() lands in dir/page.html (no findings). A clean report proves the
      // CLI normalized once and read the in-repo file.
      input = `jump${sep}..${sep}page.html`;
      trusted = resolve(dir, "trusted.json");
      writeFileSync(trusted, "{}", "utf8");
    });

    it("actually passes an unnormalized `..`-containing path", () => {
      expect(input).toContain(`${sep}..${sep}`);
    });

    for (const extra of [[], ["--ignore-config"], ["--config", "PLACEHOLDER"]]) {
      it(`reads the resolved in-repo file, flags ${extra.join(" ") || "(none)"}`, () => {
        const args = extra.map((a) => (a === "PLACEHOLDER" ? trusted : a));
        const res = runCli(["scan", input, ...args, "--format", "json"], dir);
        expect(res.status).toBe(0);
        const report = JSON.parse(res.stdout);
        expect(report.findings).toHaveLength(0); // the in-repo file (no rules), not outside/'s scarcity
        expect(res.stdout).not.toMatch(/scarcity/);
        // Report carries the normalized RELATIVE request path, not an absolute one (#1 regression).
        expect(report.input.file).toBe("page.html");
        expect(isAbsolute(report.input.file)).toBe(false);
      });
    }
  });

  it("handles a non-Error throw from an explicit config without crashing", () => {
    // An executable config can `throw "string"`. The CLI must report it and exit 1 cleanly, not die
    // with a secondary TypeError in the error sink (sanitizeForTerminal(undefined)).
    const throwTs = resolve(dir, "throw.config.ts");
    writeFileSync(throwTs, 'throw "configuration failed";\nexport default {};\n', "utf8");
    const res = runCli(["scan", page, "--config", throwTs, "--format", "json"]);
    expect(res.status).toBe(1);
    expect(res.stderr).toMatch(/configuration failed/);
    expect(res.stderr).not.toMatch(/is not iterable|TypeError/);
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

    it("an unsafe (symlinked) nearest JSON config fails closed via the real CLI", () => {
      // The fail-closed wiring in index.ts (error diagnostic → exit 1, no scan) is helper-tested;
      // this fixes it end-to-end. A symlinked fairux.config.json must stop the scan, not fall
      // through to defaults or scan anyway. (`dir/.git` already exists from the outer beforeEach.)
      writeFileSync(resolve(dir, "real.json"), "{}", "utf8");
      symlinkSync(resolve(dir, "real.json"), resolve(dir, "fairux.config.json"));
      const res = runCli(["scan", consentPage, "--format", "json"]);
      expect(res.status).toBe(1);
      expect(res.stderr).toMatch(/refusing auto-discovered config/i);
      expect(res.stdout).toBe("");
    });
  });
});
