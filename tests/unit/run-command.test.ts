import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  assertUnambiguousWindowsEnvironment,
  commandCandidateExtensions,
  commandSearchDirectories,
  isQuotableForCmd,
  resolveCommand,
  resolveWindowsCommandProcessor,
  runCommand,
  windowsCommandProcessorArgs,
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
      'import { writeFileSync } from "node:fs";',
      // Evidence that the child ran at all, for the cases that assert it did not.
      'if (process.env.MARKER) writeFileSync(process.env.MARKER, "ran");',
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

  it.each([
    ["fairux.cmd", ".EXE"],
    ["node.exe", ".CMD"],
    ["tool.bat", ".EXE"],
    ["tool.com", ".CMD"],
    ["C:\\project\\node_modules\\.bin\\fairux.cmd", ".EXE"],
  ])("resolves %s as written even when PATHEXT is %s", (command, pathext) => {
    // PATHEXT answers "what might this bare name be?". A command the caller spelled out names a
    // file, and searching for `fairux.cmd.EXE` because the host's PATHEXT omits `.CMD` confuses a
    // filename with a search — which is what `installedCliBinPath` hands over on Windows.
    expect(commandCandidateExtensions(command, { platform: "win32", pathext })).toEqual([""]);
  });

  it("drops PATHEXT entries this runner cannot start", () => {
    // A stock Windows PATHEXT lists `.VBS`, `.JS`, `.WSF`, `.MSC`. Spawning one directly fails in a
    // way that says nothing; they are dropped rather than refused, because refusing outright would
    // make every bare command fail on a default host.
    expect(
      commandCandidateExtensions("pnpm", {
        platform: "win32",
        pathext: ".COM;.EXE;.BAT;.CMD;.VBS;.JS;.WSF;.MSC",
      }),
    ).toEqual([".COM", ".EXE", ".BAT", ".CMD"]);
  });

  it("leaves nothing to probe when PATHEXT names only unrunnable extensions", () => {
    // `resolveCommand` then reports the command as not found, by name, rather than starting
    // something it cannot run.
    expect(commandCandidateExtensions("pnpm", { platform: "win32", pathext: ".JS;.PS1" })).toEqual(
      [],
    );
  });
});

describe("commandSearchDirectories", () => {
  it("resolves a relative entry against the supplied cwd, not this process's", () => {
    // `PATH=bin` means the `bin` of the directory the child will run in.
    expect(commandSearchDirectories("bin", { cwd: "/work", platform: "linux" })).toEqual([
      "/work/bin",
    ]);
  });

  it("reads an empty field as the working directory, as POSIX does", () => {
    expect(commandSearchDirectories(":/usr/bin", { cwd: "/work", platform: "linux" })).toEqual([
      "/work",
      "/usr/bin",
    ]);
    expect(commandSearchDirectories("/usr/bin:", { cwd: "/work", platform: "linux" })).toEqual([
      "/usr/bin",
      "/work",
    ]);
  });

  it("leaves an absolute entry alone", () => {
    expect(commandSearchDirectories("/usr/bin:/bin", { cwd: "/work", platform: "linux" })).toEqual([
      "/usr/bin",
      "/bin",
    ]);
  });

  it("keeps PATH order, which decides which of two candidates wins", () => {
    expect(
      commandSearchDirectories("first:/second:third", { cwd: "/work", platform: "linux" }),
    ).toEqual(["/work/first", "/second", "/work/third"]);
  });

  it("splits on the platform's own separator", () => {
    expect(
      commandSearchDirectories("C:\\bin;tools", { cwd: "C:\\work", platform: "win32" }),
    ).toHaveLength(2);
    expect(commandSearchDirectories("/a:/b", { cwd: "/work", platform: "linux" })).toHaveLength(2);
  });
});

describe("windowsCommandProcessorArgs", () => {
  it("pins the switch set, so a .cmd does not inherit host policy", () => {
    expect(windowsCommandProcessorArgs("LINE")).toEqual([
      "/d",
      "/e:on",
      "/v:off",
      "/s",
      "/c",
      "LINE",
    ]);
  });

  it("enables command extensions, which npm's own shims rely on", () => {
    // `npm.cmd`, `pnpm.cmd`, and npm's generated shims all use SETLOCAL, IF, and `%~dp0`.
    expect(windowsCommandProcessorArgs("LINE")).toContain("/e:on");
  });

  it("disables delayed expansion, so a quoted !NAME! stays literal", () => {
    // The counterpart to refusing `%`: with delayed expansion on, `!` is a second expansion syntax
    // and quoting alone would not keep an argument intact.
    expect(windowsCommandProcessorArgs("LINE")).toContain("/v:off");
  });
});

describe("resolveWindowsCommandProcessor", () => {
  const isFile = (path: string) => path.endsWith("cmd.exe");
  const absolute = `${IS_WINDOWS ? "C:\\Windows\\System32\\" : "/Windows/System32/"}cmd.exe`;

  it("returns the ComSpec the environment names", () => {
    expect(resolveWindowsCommandProcessor({ ComSpec: absolute }, { isFile })).toBe(absolute);
  });

  it("reads ComSpec under any casing on Windows", () => {
    if (!IS_WINDOWS) return;
    expect(resolveWindowsCommandProcessor({ COMSPEC: absolute }, { isFile })).toBe(absolute);
  });

  it("refuses a missing ComSpec rather than falling back to a PATH search", () => {
    // A bare `"cmd.exe"` would send the launch back through a PATH lookup, which is the step the
    // caller's environment is supposed to decide.
    expect(() => resolveWindowsCommandProcessor({}, { isFile })).toThrow(/ComSpec is missing/);
  });

  it("refuses an empty ComSpec", () => {
    expect(() => resolveWindowsCommandProcessor({ ComSpec: "" }, { isFile })).toThrow(
      /ComSpec is missing/,
    );
  });

  it("refuses a relative ComSpec", () => {
    expect(() => resolveWindowsCommandProcessor({ ComSpec: "cmd.exe" }, { isFile })).toThrow(
      /not an absolute path/,
    );
  });

  it("refuses a ComSpec that is not an .exe", () => {
    const notExe = absolute.replace("cmd.exe", "cmd.bat");
    expect(() => resolveWindowsCommandProcessor({ ComSpec: notExe }, { isFile })).toThrow(
      /not an \.exe/,
    );
  });

  it("refuses a ComSpec that is not a regular file", () => {
    expect(() =>
      resolveWindowsCommandProcessor({ ComSpec: absolute }, { isFile: () => false }),
    ).toThrow(/not a regular file/);
  });
});

describe("assertUnambiguousWindowsEnvironment", () => {
  const WIN = { platform: "win32" };

  it.each([[{ PATH: "a" }], [{ Path: "a" }], [{ path: "a" }]])(
    "accepts a single casing (%o)",
    (env) => {
      expect(() => assertUnambiguousWindowsEnvironment(env, WIN)).not.toThrow();
    },
  );

  it("refuses PATH supplied under two casings", () => {
    // Node sorts Windows env keys and gives the child the first of each case-insensitive group, so
    // a lookup walking insertion order and the child can see different values.
    expect(() => assertUnambiguousWindowsEnvironment({ path: "a", Path: "b" }, WIN)).toThrow(
      /PATH is supplied under multiple casings \(Path, path\)/,
    );
  });

  it("refuses regardless of insertion order", () => {
    expect(() => assertUnambiguousWindowsEnvironment({ Path: "b", path: "a" }, WIN)).toThrow(
      /multiple casings \(Path, path\)/,
    );
  });

  it.each([
    ["PATHEXT", { PATHEXT: "a", Pathext: "b" }],
    ["COMSPEC", { COMSPEC: "a", ComSpec: "b" }],
  ])("refuses duplicate %s casings", (name, env) => {
    expect(() => assertUnambiguousWindowsEnvironment(env, WIN)).toThrow(
      new RegExp(`${name} is supplied under multiple casings`),
    );
  });

  it("treats differing casings as different variables off Windows", () => {
    // On POSIX they really are two variables, and refusing would be wrong.
    expect(() =>
      assertUnambiguousWindowsEnvironment({ path: "a", Path: "b" }, { platform: "linux" }),
    ).not.toThrow();
  });

  it("accepts the process environment it is given by default", () => {
    expect(() => assertUnambiguousWindowsEnvironment(process.env)).not.toThrow();
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

  it("writes the marker when the child does run, so its absence means something", () => {
    // The control for the "refused before starting anything" cases: without this, an assertion that
    // the marker is absent would pass even if the marker were never written by anything.
    const marker = join(dir, "control-marker");
    rmSync(marker, { force: true });
    runCommand(process.execPath, [echoArgs], { env: { ...process.env, MARKER: marker } });
    expect(existsSync(marker)).toBe(true);
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

  /**
   * On POSIX a regular file is not necessarily a runnable one. A `probe` with mode 0644 earlier on
   * `PATH` shadowed an executable `probe` later on it: resolution stopped at the first, and the
   * spawn failed with `EACCES`. A shell skips the unreadable one and keeps looking.
   */
  describe.skipIf(IS_WINDOWS)("POSIX execute permission", () => {
    let shadow: string;
    let real: string;

    beforeAll(() => {
      shadow = join(dir, "shadow bin");
      real = join(dir, "real bin");
      for (const directory of [shadow, real]) mkdirSync(directory, { recursive: true });
      writeFileSync(join(shadow, "probe"), "#!/bin/sh\necho from shadow\n", { mode: 0o644 });
      writeFileSync(join(real, "probe"), "#!/bin/sh\necho from real\n", { mode: 0o755 });
      // Found only through an empty PATH field, which means the child's working directory.
      writeFileSync(join(real, "cwd-probe"), "#!/bin/sh\necho from real\n", { mode: 0o755 });
    });

    it("skips a non-executable candidate and takes the runnable one further along PATH", () => {
      const env = { ...process.env, PATH: `${shadow}:${real}` };
      expect(resolveCommand("probe", { env })).toBe(join(real, "probe"));
      expect(runCommand("probe", [], { env }).stdout.trim()).toBe("from real");
    });

    it("refuses before spawning when every candidate is non-executable", () => {
      // Named as present-but-unusable rather than absent: "not found" sends the reader looking for
      // a missing install instead of at a mode bit.
      expect(() => runCommand("probe", [], { env: { ...process.env, PATH: shadow } })).toThrow(
        /command found on PATH but is not executable: probe/,
      );
    });

    it("refuses an explicitly named path that is not executable", () => {
      expect(() => resolveCommand(join(shadow, "probe"))).toThrow(/is not executable/);
    });

    it("still refuses a directory", () => {
      expect(() => resolveCommand(dir)).toThrow(/not found on PATH/);
    });

    it("finds a command through a relative PATH entry, from the supplied cwd", () => {
      // The runner's own cwd is the repository; the child's is `dir`. `PATH=real bin` has to mean
      // the child's, or a command sitting exactly where the caller pointed reports as not found.
      const env = { ...process.env, PATH: "real bin" };
      expect(resolveCommand("probe", { cwd: dir, env })).toBe(join(real, "probe"));
      expect(runCommand("probe", [], { cwd: dir, env }).stdout.trim()).toBe("from real");
    });

    it("reads an empty PATH field as the child's working directory", () => {
      const env = { ...process.env, PATH: `:${shadow}` };
      expect(runCommand("cwd-probe", [], { cwd: real, env }).stdout.trim()).toBe("from real");
    });

    it("prefers an earlier relative entry only when it is runnable", () => {
      // `shadow bin` comes first and holds a 0644 `probe`; the runnable one is further along.
      const env = { ...process.env, PATH: `shadow bin:${real}` };
      expect(resolveCommand("probe", { cwd: dir, env })).toBe(join(real, "probe"));
    });

    it("does not fall back to this process's PATH when PATH is unset", () => {
      const { PATH: _removed, ...withoutPath } = process.env;
      expect(() => resolveCommand("node", { env: withoutPath })).toThrow(/not found on PATH/);
    });

    it("follows a symlink to an executable, as before", () => {
      const link = join(dir, "linked-probe");
      rmSync(link, { force: true });
      symlinkSync(join(real, "probe"), link);
      expect(runCommand(link, []).stdout.trim()).toBe("from real");
    });
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

  it.skipIf(!IS_WINDOWS)("keeps a quoted !NAME! literal, whatever the host's policy", () => {
    // With delayed expansion on — which a host, a registry value, or a parent `cmd` can enable —
    // `!FAIRUX_DELAYED_EXPANSION_PROBE!` would arrive as `expanded`. `/v:off` is what stops that,
    // and `!` is the one expansion syntax the quoting rule does not refuse.
    const probe = "!FAIRUX_DELAYED_EXPANSION_PROBE!";
    const { stdout } = runCommand(echoArgsCmd, [probe], {
      env: { ...process.env, FAIRUX_DELAYED_EXPANSION_PROBE: "expanded" },
    });
    expect(JSON.parse(stdout.trim())).toEqual([probe]);
  });

  it.skipIf(!IS_WINDOWS)(
    "finds a .cmd through a relative PATH entry, from the supplied cwd",
    () => {
      const { stdout } = runCommand(PROBE, [], {
        cwd: dir,
        env: { ...process.env, PATH: "custom bin", PATHEXT: ".CMD" },
      });
      expect(stdout.trim()).toBe("probe ran");
    },
  );

  it.skipIf(!IS_WINDOWS)("runs an explicit .cmd when PATHEXT does not list .CMD", () => {
    // `installedCliBinPath` hands over an explicit `fairux.cmd`; a host whose PATHEXT omits `.CMD`
    // must not turn that into a search for `fairux.cmd.EXE`.
    const { stdout } = runCommand(echoArgsCmd, ["ok"], {
      env: { ...process.env, PATHEXT: ".EXE" },
    });
    expect(JSON.parse(stdout.trim())).toEqual(["ok"]);
  });

  it.skipIf(!IS_WINDOWS)("refuses a duplicate-cased environment before starting anything", () => {
    const marker = join(dir, "ambiguous-env-marker");
    rmSync(marker, { force: true });
    expect(() =>
      runCommand(echoArgsCmd, ["x"], {
        env: { Path: process.env.Path ?? "", path: "C:\\nowhere", MARKER: marker },
      }),
    ).toThrow(/PATH is supplied under multiple casings/);
    // The marker mechanism is proven to work by the control below, so its absence means the child
    // never started — the refusal happened before anything was spawned.
    expect(existsSync(marker)).toBe(false);
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
