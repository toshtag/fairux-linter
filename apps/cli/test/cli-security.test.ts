import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
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
  // spawnSync (not execFileSync) so we capture stdout AND stderr on success — the trust warning goes
  // to stderr even when the scan exits 0. A hard `timeout` is essential: these tests assert the CLI
  // does NOT hang (e.g. on a FIFO target); without it, a regression would block the spawnSync call
  // synchronously and Vitest's own timeout couldn't fire. A timed-out run surfaces as a FAIL below.
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

  // The scan-target safety check must hold even with the config-bypassing flags — `--ignore-config`
  // (recommended for untrusted scans) and `--config` must NOT disable it. This guards the exact
  // bypass the round-7 review found.
  describe("symlinked scan target is refused under every flag", () => {
    let link: string;
    let trusted: string;
    beforeEach(() => {
      const outside = resolve(dir, "secret-src");
      mkdirSync(outside);
      writeFileSync(
        resolve(outside, "secret.html"),
        "<html><body><button>SECRETMARKER</button></body></html>",
        "utf8",
      );
      link = resolve(dir, "page-link.html");
      symlinkSync(resolve(outside, "secret.html"), link);
      trusted = resolve(dir, "trusted.json");
      writeFileSync(trusted, "{}", "utf8");
    });

    for (const extra of [[], ["--ignore-config"], ["--config", "PLACEHOLDER"]]) {
      it(`refused with flags: ${extra.join(" ") || "(none)"}`, () => {
        const args = extra.map((a) => (a === "PLACEHOLDER" ? trusted : a));
        const res = runCli(["scan", link, ...args, "--format", "json"]);
        expect(res.status).toBe(1); // fail closed regardless of flags
        expect(res.stderr).toMatch(/scan target is a symlink/i);
        expect(res.stdout).not.toMatch(/SECRETMARKER/); // out-of-project bytes never read
      });
    }
  });

  // Only skip on platforms without a FIFO concept (Windows). Anywhere else, a `mkfifo` failure is a
  // real test failure (not a silent pass) — we don't want a broken fixture to read as green.
  it.skipIf(process.platform === "win32")(
    "refuses a FIFO scan target without hanging (real CLI)",
    () => {
      const fifo = resolve(dir, "page.fifo.html");
      execFileSync("mkfifo", [fifo]); // a failure here fails the test, by design
      // No writer is ever attached; if the target check were skipped, readFileSync would block
      // forever — runCli's timeout turns that into a FAIL rather than a hung job.
      const res = runCli(["scan", fifo, "--ignore-config", "--format", "json"]);
      expect(res.status).toBe(1);
      expect(res.stderr).toMatch(/not a regular file/i);
    },
  );

  // The hardest case the round-8 review flagged: NO marker (.git/package.json) anywhere, and the
  // scan target is a regular file reached through an ancestor symlink that points OUT of the project.
  // Must fail closed under every flag — never self-anchor the boundary onto the symlink target.
  describe("markerless out-of-project ancestor symlink is refused under every flag", () => {
    let root: string;
    let linkPage: string;
    let linkSubPage: string;
    let trusted: string;
    beforeEach(() => {
      // <root>/host/linked -> <root>/outside ; NO .git or package.json anywhere under root.
      root = mkdtempSync(resolve(tmpdir(), "fairux-mkr-"));
      mkdirSync(resolve(root, "host"));
      mkdirSync(resolve(root, "outside", "sub"), { recursive: true });
      writeFileSync(
        resolve(root, "outside", "page.html"),
        "<html><body><button>OUTOFPROJECT</button></body></html>",
        "utf8",
      );
      writeFileSync(resolve(root, "outside", "sub", "page.html"), "<html></html>", "utf8");
      symlinkSync(resolve(root, "outside"), resolve(root, "host", "linked"));
      linkPage = resolve(root, "host", "linked", "page.html");
      linkSubPage = resolve(root, "host", "linked", "sub", "page.html");
      trusted = resolve(root, "trusted.json");
      writeFileSync(trusted, "{}", "utf8");
    });
    afterEach(() => rmSync(root, { recursive: true, force: true }));

    for (const target of ["direct", "subdir"]) {
      for (const extra of [[], ["--ignore-config"], ["--config", "PLACEHOLDER"]]) {
        it(`refused: ${target} target, flags ${extra.join(" ") || "(none)"}`, () => {
          const path = target === "direct" ? linkPage : linkSubPage;
          const args = extra.map((a) => (a === "PLACEHOLDER" ? trusted : a));
          const res = runCli(["scan", path, ...args, "--format", "json"]);
          expect(res.status).toBe(1); // fail closed even with no marker
          expect(res.stderr).toMatch(/project-escaping symlink/i);
          expect(res.stdout).not.toMatch(/OUTOFPROJECT/);
        });
      }
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
  });
});
