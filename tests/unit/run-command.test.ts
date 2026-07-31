import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveCommand, runCommand } from "../../scripts/run-command.mjs";

/**
 * The packed-CLI smoke test launches `pnpm`, `npm`, and the `fairux` shim npm generated. On Windows
 * all three are `.cmd` batch files, which `execFileSync` cannot start; the usual fix — `shell: true`
 * at every call site — hands each argument to `cmd.exe`, which is the wrong answer for a CLI that
 * must receive a glob pattern literally and run out of a temporary directory whose path it does not
 * choose.
 *
 * What can be asserted on every platform is here: resolution, that no shell is involved, that
 * arguments arrive verbatim, and that exit status and the two output streams are reported honestly.
 * The `cmd.exe` branch itself is exercised for real rather than in a unit test — `pnpm pack:smoke`
 * on the Windows matrix runs `npm.cmd`, `pnpm.cmd`, and `fairux.cmd` through this module.
 */

let dir: string;
let echoArgs: string;

beforeAll(() => {
  // A space in the path is not incidental: it is the case a hand-built command line gets wrong.
  dir = mkdtempSync(join(tmpdir(), "fairux run cmd-"));
  echoArgs = join(dir, "echo-args.mjs");
  writeFileSync(
    echoArgs,
    [
      "process.stdout.write(JSON.stringify(process.argv.slice(2)));",
      'process.stderr.write("diagnostic");',
      'const code = Number(process.env.EXIT_CODE ?? "0");',
      "process.exitCode = code;",
    ].join("\n"),
    "utf8",
  );
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("resolveCommand", () => {
  it("resolves an absolute path to itself", () => {
    expect(resolveCommand(process.execPath)).toBe(resolve(process.execPath));
  });

  it("finds a bare command name on PATH", () => {
    // `node` is on PATH wherever this test runs, and on Windows only because PATHEXT is applied —
    // which a non-shell spawn does not do for you.
    expect(resolveCommand("node").length).toBeGreaterThan(0);
  });

  it("refuses a command that is not on PATH rather than failing later at spawn", () => {
    expect(() => resolveCommand("fairux-no-such-command")).toThrow(/not found on PATH/);
  });

  it("does not resolve a directory as if it were an executable", () => {
    expect(() => resolveCommand(dir)).toThrow(/not found on PATH/);
  });
});

describe("runCommand", () => {
  it("passes arguments verbatim, with no shell expansion", () => {
    // Every one of these is a character `cmd.exe` or `sh` would act on. The CLI's own glob support
    // depends on receiving the pattern, not a file list a shell resolved on its behalf.
    const args = ["inputs/*.html", "a&b", "c|d", "e>f", "g<h", "(i)", "j;k"];
    const { stdout } = runCommand(process.execPath, [echoArgs, ...args]);
    expect(JSON.parse(stdout)).toEqual(args);
  });

  it("runs out of a working directory whose path contains a space", () => {
    const { stdout } = runCommand(process.execPath, [echoArgs, "ok"], { cwd: dir });
    expect(JSON.parse(stdout)).toEqual(["ok"]);
  });

  it("keeps stdout and stderr separate", () => {
    const { stdout, stderr } = runCommand(process.execPath, [echoArgs]);
    expect(JSON.parse(stdout)).toEqual([]);
    expect(stderr).toBe("diagnostic");
  });

  it("writes stdin to the child", () => {
    const { stdout } = runCommand(process.execPath, ["-e", "process.stdin.pipe(process.stdout)"], {
      input: "piped",
    });
    expect(stdout).toBe("piped");
  });

  it("throws when the exit status is not the expected one", () => {
    expect(() =>
      runCommand(process.execPath, [echoArgs], { env: { ...process.env, EXIT_CODE: "3" } }),
    ).toThrow(/exited with 3, expected 0/);
  });

  it("accepts a non-zero exit the caller asked for", () => {
    const { status } = runCommand(process.execPath, [echoArgs], {
      env: { ...process.env, EXIT_CODE: "2" },
      expectStatus: 2,
    });
    expect(status).toBe(2);
  });

  it("reports any status when the caller does not pin one", () => {
    const { status } = runCommand(process.execPath, [echoArgs], {
      env: { ...process.env, EXIT_CODE: "7" },
      expectStatus: null,
    });
    expect(status).toBe(7);
  });

  it("names the command that could not be started", () => {
    expect(() => runCommand("fairux-no-such-command", [])).toThrow(/not found on PATH/);
  });
});
