/**
 * Run a build/packaging tool the same way on Linux, macOS, and Windows.
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

/**
 * Can this argument be handed to `cmd.exe` inside double quotes and arrive unchanged?
 *
 * Exported for the same reason as `commandCandidateExtensions`: the rule decides what happens on
 * Windows, and a rule only Windows can check is the situation this module exists to end. The real
 * refusal is exercised against a batch file on the Windows matrix as well.
 *
 * @param {string} argument
 * @returns {boolean}
 */
export function isQuotableForCmd(argument) {
  return !UNQUOTABLE_FOR_CMD.test(argument);
}

/**
 * Read an environment variable the way the platform reads it.
 *
 * Windows environment variable names are case-insensitive, and `process.env` there is a proxy that
 * honours that. A plain object handed in as `options.env` is not — `{ Path: … }` and `{ PATH: … }`
 * are two different keys to it, while the child process sees one variable. Resolution has to agree
 * with the child, so the lookup is case-insensitive on Windows and exact everywhere else, where
 * `Path` and `PATH` really are different variables.
 *
 * @param {NodeJS.ProcessEnv} env
 * @param {string} name
 * @returns {string | undefined}
 */
function envValue(env, name) {
  if (env[name] !== undefined) return env[name];
  if (!IS_WINDOWS) return undefined;
  const wanted = name.toLowerCase();
  for (const key of Object.keys(env)) {
    if (key.toLowerCase() === wanted) return env[key];
  }
  return undefined;
}

function isExecutableFile(candidate) {
  try {
    return existsSync(candidate) && statSync(candidate).isFile();
  } catch {
    return false;
  }
}

/**
 * Which suffixes to append to a candidate, in order.
 *
 * On Windows an extension is not decoration: it is what makes a file executable at all. `pnpm` and
 * `npm` each install a `.cmd` **and** an extensionless POSIX shell script side by side, so probing
 * the empty extension first finds the shell script — a real file, which `existsSync` and `statSync`
 * both confirm — and spawning it fails with `ENOENT`, because Windows has nothing to run it with.
 * That is exactly what the first Windows run of `pack-smoke-windows` hit. The empty extension is
 * therefore offered only when the command already ends in one `PATHEXT` names, which is how an
 * explicit `fairux.cmd` or `node.exe` still resolves to itself.
 *
 * Exported and parameterised so the Windows rule is testable from any host: a rule that can only be
 * checked by running Windows is the situation this whole module exists to end.
 *
 * @param {string} command
 * @param {{platform?: string, pathext?: string}} [environment]
 * @returns {string[]} suffixes to try, in order
 */
export function commandCandidateExtensions(command, { platform = process.platform, pathext } = {}) {
  if (platform !== "win32") return [""];
  const extensions = (pathext ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean);
  const alreadyExecutable = extensions.some((extension) =>
    command.toLowerCase().endsWith(extension.toLowerCase()),
  );
  return alreadyExecutable ? [""] : extensions;
}

/**
 * Find the file a command name refers to.
 *
 * A name containing a separator is a path and is probed as given (plus `PATHEXT` on Windows); a
 * bare name is searched along `PATH`. Returning the resolved *file* is what lets the caller spawn
 * without a shell — and what lets this module see that the target is a batch file.
 *
 * `PATH` and `PATHEXT` come from `env`, which is the environment the child will actually run in.
 * Resolving against `process.env` while the child ran with something else meant a caller could be
 * handed a command its own `env` does not contain — either failing to find one it had added, or
 * silently selecting one it had deliberately removed and then executing it under the scrubbed
 * environment. Which binary runs and what the process can see have to be decided together.
 *
 * @param {string} command
 * @param {{cwd?: string, env?: NodeJS.ProcessEnv}} [options]
 * @returns {string} absolute path to the executable
 * @throws when nothing on `PATH` matches
 */
export function resolveCommand(command, { cwd = process.cwd(), env = process.env } = {}) {
  const extensions = commandCandidateExtensions(command, { pathext: envValue(env, "PATHEXT") });
  const looksLikePath = command.includes("/") || (IS_WINDOWS && command.includes("\\"));

  const directories = looksLikePath
    ? [isAbsolute(command) ? "" : cwd]
    : (envValue(env, "PATH") ?? "").split(delimiter).filter(Boolean);

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
    if (!isQuotableForCmd(argument)) {
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

  const executable = resolveCommand(command, { cwd, env });
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
        envValue(env, "ComSpec") ?? "cmd.exe",
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
