/**
 * Run a build/packaging tool the same way on every host this repository supports.
 *
 * `execFileSync("npm", […])` is not portable. On Windows the thing on `PATH` is `npm.cmd`, a batch
 * file: `CreateProcess` will not launch it, and since the CVE-2024-27980 fix Node refuses to try.
 * The usual patch is `shell: true`, which hands the whole command line to `cmd.exe` — and with it
 * every argument, including a glob pattern the CLI is supposed to receive literally, a `&` in a
 * temporary path, or a `%VAR%` that `cmd` would expand before the program ever sees it. Scattering
 * `shell: true` across call sites spreads that exposure to each one.
 *
 * So the shell is confined to here, and only to the case that requires it:
 *
 * - **Everything resolvable to a real executable is spawned directly**, argv-by-argv, no shell. On
 *   POSIX that is every case.
 * - **A `.cmd`/`.bat` target is launched through `cmd.exe /d /s /c`**, the same mechanism
 *   `shell: true` uses, with the command line built here under one quoting rule.
 * - **Arguments that rule cannot express are refused, not escaped.** Inside double quotes `cmd`
 *   leaves `&`, `|`, `<`, `>` and `^` alone but still expands `%…%`, and there is no in-line escape
 *   for `%` on a command line (`%%` only works inside a batch file). An argument carrying `%`, a
 *   quote, a newline, or a NUL therefore throws instead of being passed through approximately.
 *   Nothing this repository runs needs one, so the refusal costs nothing and closes the hole.
 *
 * `PATH` resolution is done here too, because a non-shell spawn on Windows applies no `PATHEXT`
 * search: `npm` would simply not be found.
 */
import { spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { delimiter, isAbsolute, join, resolve } from "node:path";

const IS_WINDOWS = process.platform === "win32";

/** Extensions `cmd.exe` must run rather than `CreateProcess`. */
const SHELL_EXTENSIONS = [".cmd", ".bat"];

/**
 * Characters a double-quoted `cmd.exe` argument cannot carry: the quote that would close it,
 * `%` which `cmd` expands even inside quotes, and the terminators that end a command line.
 * A space is deliberately absent — quoting is exactly what makes a path with spaces work.
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: refusing control characters is the point
const UNQUOTABLE_FOR_CMD = /["%]|[\u0000-\u001f]/;

function isExecutableFile(candidate) {
  try {
    return existsSync(candidate) && statSync(candidate).isFile();
  } catch {
    return false;
  }
}

function windowsExtensions() {
  const pathext = process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD";
  return pathext.split(";").filter(Boolean);
}

/**
 * Find the file a command name refers to.
 *
 * A name containing a separator is a path and is probed as given (plus `PATHEXT` on Windows); a
 * bare name is searched along `PATH`. Returning the resolved *file* is what lets the caller spawn
 * without a shell — and what lets this module see that the target is a batch file.
 *
 * @param {string} command
 * @param {{cwd?: string}} [options]
 * @returns {string} absolute path to the executable
 * @throws when nothing on `PATH` matches
 */
export function resolveCommand(command, { cwd = process.cwd() } = {}) {
  const extensions = IS_WINDOWS ? ["", ...windowsExtensions()] : [""];
  const looksLikePath = command.includes("/") || (IS_WINDOWS && command.includes("\\"));

  const directories = looksLikePath
    ? [isAbsolute(command) ? "" : cwd]
    : (process.env.PATH ?? "").split(delimiter).filter(Boolean);

  for (const directory of directories) {
    const base = directory === "" ? command : join(directory, command);
    for (const extension of extensions) {
      const candidate = `${base}${extension}`;
      if (isExecutableFile(candidate)) return resolve(candidate);
    }
  }

  throw new Error(`command not found on PATH: ${command}`);
}

/**
 * Build the `cmd.exe /d /s /c` command line for a batch target.
 *
 * With `/s`, `cmd` strips the outermost quote pair and takes the remainder verbatim, so each
 * argument is quoted exactly once here and `windowsVerbatimArguments` stops Node re-quoting it.
 *
 * @param {string} executable  resolved path to the `.cmd`/`.bat` file
 * @param {readonly string[]} args
 * @returns {string}
 */
function cmdCommandLine(executable, args) {
  for (const argument of [executable, ...args]) {
    if (UNQUOTABLE_FOR_CMD.test(argument)) {
      throw new Error(
        `refusing to run ${executable} through cmd.exe: an argument contains a character that ` +
          `cannot be quoted safely (%, ", CR, LF, or NUL)`,
      );
    }
  }
  return `"${[executable, ...args].map((argument) => `"${argument}"`).join(" ")}"`;
}

/**
 * @typedef {object} RunCommandResult
 * @property {number} status  the exit code
 * @property {string} stdout
 * @property {string} stderr
 */

/**
 * Run a command and capture its streams separately.
 *
 * @param {string} command  executable name or path
 * @param {readonly string[]} [args]
 * @param {object} [options]
 * @param {string} [options.cwd]
 * @param {NodeJS.ProcessEnv} [options.env]
 * @param {string} [options.input]  written to stdin; stdin is closed when absent
 * @param {number} [options.timeout]
 * @param {number} [options.maxBuffer]
 * @param {number|null} [options.expectStatus]  exit code to require; `null` accepts any
 * @returns {RunCommandResult}
 * @throws when the command cannot be spawned, times out, or exits with an unexpected status
 */
export function runCommand(command, args = [], options = {}) {
  const {
    cwd = process.cwd(),
    env = process.env,
    input,
    timeout = 120_000,
    maxBuffer = 32 * 1024 * 1024,
    expectStatus = 0,
  } = options;

  const executable = resolveCommand(command, { cwd });
  const needsCmd =
    IS_WINDOWS &&
    SHELL_EXTENSIONS.some((extension) => executable.toLowerCase().endsWith(extension));

  const spawnOptions = {
    cwd,
    env,
    encoding: "utf8",
    timeout,
    maxBuffer,
    input,
    stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    // Never `shell: true`: when `cmd.exe` is needed it is named explicitly below, with a command
    // line this module built, so there is exactly one place where quoting has to be right.
    shell: false,
    windowsHide: true,
  };

  const result = needsCmd
    ? spawnSync(
        process.env.ComSpec ?? "cmd.exe",
        ["/d", "/s", "/c", cmdCommandLine(executable, args)],
        {
          ...spawnOptions,
          windowsVerbatimArguments: true,
        },
      )
    : spawnSync(executable, [...args], spawnOptions);

  if (result.error) {
    throw new Error(`failed to run ${command}: ${result.error.message}`);
  }
  if (result.signal) {
    throw new Error(`${command} was terminated by ${result.signal}`);
  }

  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  const status = result.status ?? -1;

  if (expectStatus !== null && status !== expectStatus) {
    const detail = `${stdout}${stderr}`.trim().slice(0, 2000);
    throw new Error(
      `${command} exited with ${status}, expected ${expectStatus}${detail ? `:\n${detail}` : ""}`,
    );
  }

  return { status, stdout, stderr };
}
