import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DEFAULT_TIMEOUT, run, runSync } from "../../scripts/release-subprocess.mjs";

/**
 * The release scripts' subprocess runner, and the portability rule it has to keep.
 *
 * It called `execFileSync("npm", …)` directly. That is not portable: on Windows the `npm` on `PATH`
 * is `npm.cmd`, a batch file `CreateProcess` will not launch and Node refuses to try since the
 * CVE-2024-27980 fix. `scripts/run-command.mjs` exists for exactly this and says so in its first
 * paragraph — and this module, which every release script's registry read goes through, did not use
 * it.
 *
 * What that cost: both Windows cells of `registry-cli-smoke.yml` failed at their first `npm view`,
 * about a tenth of a second in, reporting `{"status":"unavailable"}`. A spawn failure and an absent
 * package come out of `readNpmRegistryState` wearing the same word, so for the whole period when
 * `fairux` really was absent the two were indistinguishable — the canary was red for the reason
 * everyone expected and also for one nobody had seen.
 *
 * These tests run on every platform. The Windows-specific behaviour is checked through the rules
 * `run-command.mjs` exports rather than by running Windows, which is the same approach
 * `tests/unit/run-command.test.ts` takes and for the same reason: a rule only one platform can
 * check is the situation that module exists to end.
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const source = readFileSync(resolve(root, "scripts/release-subprocess.mjs"), "utf8");

describe("the release subprocess runner resolves before it spawns", () => {
  it("uses the repository's command resolution rather than a bare name", () => {
    // The defect, as a check: `execFileSync(cmd, …)` with the caller's string is what could not
    // launch `npm.cmd`.
    expect(source).toContain('from "./run-command.mjs"');
    expect(source).toContain("resolveCommand(cmd");
    expect(source).not.toMatch(/execFileSync\(\s*cmd\s*,/);
  });

  it("routes a Windows batch target through the command processor, not through shell: true", () => {
    // `shell: true` would hand every argument to `cmd.exe` — including a registry URL and a package
    // spec — under quoting rules nobody here controls.
    expect(source).toContain("windowsCommandProcessorArgs");
    expect(source).toContain("resolveWindowsCommandProcessor");
    expect(source).toContain("windowsVerbatimArguments: true");
    expect(source).not.toContain("shell: true");
  });

  it("refuses an argument the quoting rule cannot express rather than escaping it", () => {
    expect(source).toContain("isQuotableForCmd");
    expect(source).toContain("cannot ");
  });

  it("keeps Node built-ins only, because the publish jobs run it with no dependency tree", () => {
    const imports = [...source.matchAll(/^import .*? from "([^"]+)";$/gm)].map((m) => m[1]);
    for (const specifier of imports) {
      expect(specifier === "node:child_process" || specifier?.startsWith("./"), specifier).toBe(
        true,
      );
    }
  });
});

describe("the error contract this module owns", () => {
  it("still carries the spawn code, which is how a timeout is told from a failure", () => {
    // The property the module was extracted to protect. A registry read killed by the caller's
    // deadline and one that failed on its own are different facts, and `code` is the only thing
    // that distinguishes them.
    expect(() => run("node", ["-e", "process.exit(3)"])).toThrow();
    try {
      run("node", ["-e", "process.exit(3)"]);
    } catch (error) {
      expect((error as { status?: number }).status).toBe(3);
    }
  });

  it("carries stdout and stderr onto the thrown error", () => {
    try {
      run("node", ["-e", "console.log('out'); console.error('err'); process.exit(1)"]);
    } catch (error) {
      expect((error as { stdout?: string }).stdout).toContain("out");
      expect((error as { stderr?: string }).stderr).toContain("err");
    }
  });

  it("reports ETIMEDOUT as its own code when the deadline kills the child", () => {
    try {
      run("node", ["-e", "setTimeout(() => {}, 5000)"], { timeout: 200 });
      throw new Error("expected the timeout to kill it");
    } catch (error) {
      expect((error as { code?: string }).code).toBe("ETIMEDOUT");
    }
  });

  it("returns the child's stdout on success", () => {
    expect(run("node", ["-e", "process.stdout.write('ok')"])).toBe("ok");
    expect(runSync("node", ["-e", "process.stdout.write('ok')"])).toBe("ok");
  });

  it("names a command that is not on PATH rather than failing obscurely", () => {
    expect(() => run("fairux-no-such-command-anywhere", [])).toThrow(/not found on PATH/);
  });

  it("keeps its default timeout", () => {
    expect(DEFAULT_TIMEOUT).toBe(120_000);
  });
});
