import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  commandCandidateExtensions,
  isQuotableForCmd,
  resolveCommand,
  runCommand,
} from "../../scripts/run-command.mjs";

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

const IS_WINDOWS = process.platform === "win32";

/** An argument the `cmd.exe` quoting rule cannot express, so the runner must refuse it. */
const UNQUOTABLE = [
  ["a percent expansion", "%PATH%"],
  ["an embedded quote", 'a"b'],
  ["a newline", ["line", "break"].join("\n")],
  ["a NUL", `nul${String.fromCharCode(0)}byte`],
] as const;

let dir: string;
let echoArgs: string;
let echoArgsCmd: string;
let customBin: string;
const PROBE = "fairux-env-probe";

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

  // A real batch file, under the same path-with-spaces, so the Windows `cmd.exe` branch is
  // exercised rather than inferred from the `.exe` branch a `process.execPath` test takes. It
  // forwards `%*` verbatim and adds no escaping of its own — anything the arguments survive is the
  // runner's doing.
  echoArgsCmd = join(dir, "echo-args.cmd");
  writeFileSync(echoArgsCmd, `@echo off\r\n"${process.execPath}" "${echoArgs}" %*\r\n`, "utf8");

  // A command that exists only on a caller-supplied PATH, under a name the parent PATH cannot have.
  customBin = join(dir, "custom bin");
  mkdirSync(customBin, { recursive: true });
  if (IS_WINDOWS) {
    writeFileSync(join(customBin, `${PROBE}.cmd`), "@echo off\r\necho probe ran\r\n", "utf8");
  } else {
    writeFileSync(join(customBin, PROBE), "#!/bin/sh\necho probe ran\n", { mode: 0o755 });
  }
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("commandCandidateExtensions", () => {
  const WINDOWS = { platform: "win32", pathext: ".COM;.EXE;.BAT;.CMD" };

  it("never appends an extension off Windows", () => {
    expect(commandCandidateExtensions("pnpm", { platform: "linux" })).toEqual([""]);
    expect(commandCandidateExtensions("fairux", { platform: "darwin" })).toEqual([""]);
  });

  it("does not offer the empty extension for a bare name on Windows", () => {
    // The first Windows run of `pack-smoke-windows` failed here: `pnpm` ships a `.cmd` and an
    // extensionless POSIX shell script side by side, so probing the empty extension first resolved
    // to the shell script — a real file — and spawning it failed with ENOENT, because Windows has
    // nothing to run it with.
    expect(commandCandidateExtensions("pnpm", WINDOWS)).not.toContain("");
    expect(commandCandidateExtensions("pnpm", WINDOWS)).toEqual([".COM", ".EXE", ".BAT", ".CMD"]);
  });

  it("takes a command that already names an executable extension as-is", () => {
    // `installedCliBinPath` hands over `…\.bin\fairux.cmd`; appending `.CMD` to that finds nothing.
    expect(commandCandidateExtensions("C:\\p\\node_modules\\.bin\\fairux.cmd", WINDOWS)).toEqual([
      "",
    ]);
    expect(commandCandidateExtensions("C:\\Program Files\\nodejs\\node.exe", WINDOWS)).toEqual([
      "",
    ]);
  });

  it("compares the extension case-insensitively, as Windows does", () => {
    expect(commandCandidateExtensions("FAIRUX.CMD", WINDOWS)).toEqual([""]);
    expect(commandCandidateExtensions("node.EXE", WINDOWS)).toEqual([""]);
  });

  it("honours a PATHEXT the host actually declares", () => {
    expect(commandCandidateExtensions("tool", { platform: "win32", pathext: ".EXE;.CMD" })).toEqual(
      [".EXE", ".CMD"],
    );
  });

  it("falls back to the standard set when PATHEXT is absent", () => {
    expect(commandCandidateExtensions("tool", { platform: "win32", pathext: undefined })).toEqual([
      ".COM",
      ".EXE",
      ".BAT",
      ".CMD",
    ]);
  });
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

/**
 * Which binary runs and what the process can see are one decision, not two.
 *
 * `runCommand` passed `options.env` to the child but resolved the command against `process.env`, so
 * a caller could be handed a command its own environment does not contain — failing to find one it
 * had added, or selecting one it had deliberately removed and then running it under the scrubbed
 * environment it thought it had imposed.
 */
describe("command resolution uses the environment the child will run in", () => {
  it("finds a command that exists only on the supplied PATH", () => {
    const { stdout } = runCommand(PROBE, [], { env: { ...process.env, PATH: customBin } });
    expect(stdout.trim()).toBe("probe ran");
  });

  it("does not fall back to the parent PATH for a command the supplied PATH lacks", () => {
    // `node` is certainly on the parent PATH; it is certainly not in `custom bin`.
    expect(() => runCommand("node", ["-e", ""], { env: { PATH: customBin } })).toThrow(
      /not found on PATH/,
    );
  });

  it("resolves from the supplied PATH without running anything", () => {
    const resolved = resolveCommand(PROBE, { env: { ...process.env, PATH: customBin } });
    expect(resolved.startsWith(customBin)).toBe(true);
  });

  it("delivers the supplied environment to the child", () => {
    const { stdout } = runCommand(
      process.execPath,
      ["-e", "process.stdout.write(process.env.FX)"],
      {
        env: { ...process.env, FX: "supplied" },
      },
    );
    expect(stdout).toBe("supplied");
  });

  it("keeps resolving against the process environment when no env is supplied", () => {
    expect(resolveCommand("node").length).toBeGreaterThan(0);
  });

  it.skipIf(!IS_WINDOWS)("reads PATH under any casing, as Windows does", () => {
    // A plain object is case-sensitive where `process.env` on Windows is not; the child sees one
    // variable either way, so resolution has to agree with the child rather than with the object.
    const resolved = resolveCommand(PROBE, { env: { Path: customBin } });
    expect(resolved.startsWith(customBin)).toBe(true);
  });

  it.skipIf(!IS_WINDOWS)("honours a supplied PATHEXT", () => {
    const resolved = resolveCommand(PROBE, {
      env: { ...process.env, PATH: customBin, PATHEXT: ".CMD" },
    });
    expect(resolved.toLowerCase().endsWith(".cmd")).toBe(true);
  });
});

/**
 * The `.cmd` branch, on Windows, for real.
 *
 * Every argument case above runs `process.execPath` — an `.exe`, which takes the direct-spawn
 * branch and never touches `cmd.exe`. The packed smoke does drive real `.cmd` shims, but under a
 * runner temp path that happens to contain no spaces and without pinning any quoting rule. These
 * run a batch file under a directory whose name has a space in it.
 */
describe("the cmd.exe branch", () => {
  const METACHARACTERS = [
    "plain",
    "value with spaces",
    "inputs/*.html",
    "a&b",
    "c|d",
    "e>f",
    "g<h",
    "^caret",
    "(paren)",
    "semi;colon",
  ];

  it.skipIf(!IS_WINDOWS)("passes every shell metacharacter through a real .cmd unchanged", () => {
    const { stdout } = runCommand(echoArgsCmd, METACHARACTERS);
    expect(JSON.parse(stdout.trim())).toEqual(METACHARACTERS);
  });

  it.skipIf(!IS_WINDOWS)("runs a .cmd whose own path contains a space", () => {
    expect(echoArgsCmd).toContain(" ");
    const { stdout } = runCommand(echoArgsCmd, ["ok"]);
    expect(JSON.parse(stdout.trim())).toEqual(["ok"]);
  });

  it.skipIf(!IS_WINDOWS)("reports a .cmd exit status rather than swallowing it", () => {
    const { status } = runCommand(echoArgsCmd, [], {
      env: { ...process.env, EXIT_CODE: "3" },
      expectStatus: 3,
    });
    expect(status).toBe(3);
  });

  it.each(UNQUOTABLE)("judges an argument carrying %s unquotable, on any host", (_l, argument) => {
    expect(isQuotableForCmd(argument)).toBe(false);
  });

  it.each(METACHARACTERS.map((argument) => [argument]))("judges %s quotable", (argument) => {
    expect(isQuotableForCmd(argument)).toBe(true);
  });

  // Reported as skipped off Windows rather than passing vacuously: a case that cannot run here
  // should say so, not add to the count.
  it.skipIf(!IS_WINDOWS).each(UNQUOTABLE)(
    "actually refuses an argument carrying %s",
    (_l, argument) => {
      // `%PATH%` matters most: `cmd` expands it inside quotes, so passing it through would hand the
      // program something other than what the caller wrote.
      expect(() => runCommand(echoArgsCmd, [argument])).toThrow(/cannot be quoted safely/);
    },
  );
});
