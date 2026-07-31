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
import { accessSync, constants, existsSync, statSync } from "node:fs";
import { isAbsolute, join, posix as posixPaths, resolve, win32 as win32Paths } from "node:path";

const IS_WINDOWS = process.platform === "win32";

/** Extensions `cmd.exe` must run rather than `CreateProcess`. */
const SHELL_EXTENSIONS = [".cmd", ".bat"];

/** Everything this runner knows how to start on Windows, directly or through `cmd.exe`. */
const RUNNABLE_EXTENSIONS = [".com", ".exe", ".bat", ".cmd"];

const DEFAULT_PATHEXT = ".COM;.EXE;.BAT;.CMD";

/**
 * The switches every batch launch is made with, so what a `.cmd` sees does not depend on the host.
 *
 * - `/d` skips `AutoRun`, so a registry-installed command cannot run first.
 * - `/e:on` enables command extensions, which `npm.cmd`, `pnpm.cmd`, and npm's generated shims all
 *   rely on (`SETLOCAL`, `IF`, `%~dp0`). A host with them disabled would break those shims.
 * - `/v:off` disables delayed expansion, so a `!NAME!` inside a quoted argument stays literal. This
 *   is the counterpart to refusing `%`: with delayed expansion on, `!` is a second expansion
 *   syntax, and the quoting rule alone would not keep an argument intact.
 * - `/s /c` is what makes the single-outer-quote command line below correct.
 *
 * Command-line switches beat the registry values they correspond to, which is why stating them here
 * is enough. Exported so the exact set is checkable from any host.
 *
 * @param {string} commandLine  already quoted by `cmdCommandLine`
 * @returns {string[]}
 */
export function windowsCommandProcessorArgs(commandLine) {
  return ["/d", "/e:on", "/v:off", "/s", "/c", commandLine];
}

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
/**
 * Refuse a Windows environment that names the same variable under two casings.
 *
 * Windows treats `PATH`, `Path`, and `path` as one variable; a plain JavaScript object treats them
 * as three keys. When Node builds a Windows child environment it sorts the keys and keeps the first
 * of each case-insensitive group — so `{ path: A, Path: B }` gives the child `Path`, while a lookup
 * that walked insertion order would pick `path`. The runner would then resolve an executable from
 * one `PATH` and hand the child the other, which is the split this module exists to prevent.
 *
 * Node's rule could be reimplemented here instead, but that would silently pick one of two values
 * the caller cannot have meant to supply both of. Refusing says which keys collided.
 *
 * @param {NodeJS.ProcessEnv} env
 * @param {{platform?: string}} [environment]
 * @throws when two keys differ only by case
 */
export function assertUnambiguousWindowsEnvironment(env, { platform = process.platform } = {}) {
  if (platform !== "win32") return;
  const byLowerCase = new Map();
  for (const key of Object.keys(env)) {
    const group = byLowerCase.get(key.toLowerCase()) ?? [];
    group.push(key);
    byLowerCase.set(key.toLowerCase(), group);
  }
  for (const [name, keys] of byLowerCase) {
    if (keys.length > 1) {
      throw new Error(
        `refusing an ambiguous Windows environment: ${name.toUpperCase()} is supplied under ` +
          `multiple casings (${[...keys].sort().join(", ")})`,
      );
    }
  }
}

/**
 * The command processor a batch launch will use, validated before anything is started.
 *
 * Falling back to a bare `"cmd.exe"` would send the launch back through a `PATH` search — the very
 * step the caller's environment is supposed to decide — so a `ComSpec` that is missing, relative,
 * or not an executable file is a refusal rather than a reason to guess.
 *
 * @param {NodeJS.ProcessEnv} env
 * @param {{isFile?: (path: string) => boolean}} [dependencies]  for checking from a non-Windows host
 * @returns {string} absolute path to the command processor
 * @throws when the environment does not name one
 */
export function resolveWindowsCommandProcessor(env, { isFile = isRegularFile } = {}) {
  const comspec = envValue(env, "ComSpec");
  const refuse = (why) =>
    new Error(`refusing to launch a batch command: the supplied ComSpec ${why}`);
  if (comspec === undefined || comspec === "") throw refuse("is missing");
  if (!isAbsolute(comspec)) throw refuse(`is not an absolute path (${comspec})`);
  if (!comspec.toLowerCase().endsWith(".exe")) throw refuse(`is not an .exe (${comspec})`);
  if (!isFile(comspec)) throw refuse(`is not a regular file (${comspec})`);
  return comspec;
}

function envValue(env, name) {
  if (env[name] !== undefined) return env[name];
  if (!IS_WINDOWS) return undefined;
  const wanted = name.toLowerCase();
  for (const key of Object.keys(env)) {
    if (key.toLowerCase() === wanted) return env[key];
  }
  return undefined;
}

function isRegularFile(candidate) {
  try {
    return existsSync(candidate) && statSync(candidate).isFile();
  } catch {
    return false;
  }
}

/**
 * Is this candidate something the platform will actually start?
 *
 * On POSIX, being a regular file is not enough: a `probe` with mode 0644 earlier on `PATH` shadowed
 * an executable `probe` later on it, and the runner resolved the first and failed the spawn with
 * `EACCES`. A shell skips the unreadable one and keeps looking, and so must this — the search is
 * for a runnable command, not for a filename.
 *
 * On Windows the execute bit does not exist; what makes a file startable there is its extension,
 * which `commandCandidateExtensions` already decides.
 *
 * This is a check, not a guarantee: permissions can change between the check and the spawn. It
 * removes a deterministic wrong answer, not the race.
 *
 * @param {string} candidate
 * @returns {boolean}
 */
function isRunnableFile(candidate) {
  if (!isRegularFile(candidate)) return false;
  if (IS_WINDOWS) return true;
  try {
    accessSync(candidate, constants.X_OK);
    return true;
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
 * That is exactly what the first Windows run of `pack-smoke-windows` hit.
 *
 * `PATHEXT` answers "what might this bare name be?", and only that. A command the caller spelled
 * out — `…\.bin\fairux.cmd`, `node.exe` — names a file, and searching for `fairux.cmd.EXE` because
 * the host's `PATHEXT` happens not to list `.CMD` confuses a filename with a search. Explicitly
 * named executables are therefore probed as written, whatever `PATHEXT` says.
 *
 * `PATHEXT` on a stock Windows host also lists `.VBS`, `.JS`, `.WSF`, and `.MSC`, none of which
 * `CreateProcess` can start and none of which this runner knows how to launch. They are dropped
 * from the candidate list rather than refused outright: refusing would make every bare command fail
 * on a default host, which trades a confusing `ENOENT` for a certain one. A bare name that matches
 * nothing runnable still ends in the named `command not found on PATH`.
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
  const namesAnExecutable = RUNNABLE_EXTENSIONS.some((extension) =>
    command.toLowerCase().endsWith(extension),
  );
  if (namesAnExecutable) return [""];
  return (pathext ?? DEFAULT_PATHEXT)
    .split(";")
    .filter(Boolean)
    .filter((extension) => RUNNABLE_EXTENSIONS.includes(extension.toLowerCase()));
}

/**
 * The directories a bare command name is searched in, as the caller's `cwd` defines them.
 *
 * A `PATH` entry is not always absolute. `PATH=bin` means "the `bin` directory of the working
 * directory", and POSIX gives an *empty* field the same meaning as `.` — both of which were being
 * resolved against this process's own directory rather than the `cwd` the child would run in, so a
 * command sitting exactly where the caller pointed reported as not found.
 *
 * Empty fields are honoured rather than dropped because the job here is to describe the caller's
 * `PATH`, not to improve it. An implicit working directory on `PATH` is a hazard, but silently
 * deleting a field the caller wrote would make this function answer a different question from the
 * one the operating system answers.
 *
 * `platform` selects the separator **and** the path semantics, so the rule is checkable from any
 * host. Parameterising only the separator left the joining to whichever `node:path` the test
 * happened to run on, which made a POSIX expectation fail on Windows for reasons that had nothing
 * to do with the rule.
 *
 * @param {string} pathValue  the raw `PATH`
 * @param {{cwd?: string, platform?: string}} [environment]
 * @returns {string[]} absolute directories, in `PATH` order
 */
export function commandSearchDirectories(
  pathValue,
  { cwd = process.cwd(), platform = process.platform } = {},
) {
  const windows = platform === "win32";
  const semantics = windows ? win32Paths : posixPaths;
  return pathValue
    .split(windows ? ";" : ":")
    .map((entry) => (entry === "" ? cwd : semantics.resolve(cwd, entry)));
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
  assertUnambiguousWindowsEnvironment(env);
  const extensions = commandCandidateExtensions(command, { pathext: envValue(env, "PATHEXT") });
  const looksLikePath = command.includes("/") || (IS_WINDOWS && command.includes("\\"));

  // An unset `PATH` and an empty one are different: the first has no search list at all, the second
  // has a single empty field, which means the working directory. Neither falls back to this
  // process's `PATH`, which the caller may have removed something from deliberately.
  const pathValue = envValue(env, "PATH");
  const directories = looksLikePath
    ? [isAbsolute(command) ? "" : cwd]
    : pathValue === undefined
      ? []
      : commandSearchDirectories(pathValue, { cwd });

  // Remembered so a command that is present but unusable does not report as absent, which sends the
  // reader looking for a missing install rather than at a mode bit.
  let shadowed;

  for (const directory of directories) {
    const base = directory === "" ? command : join(directory, command);
    for (const extension of extensions) {
      const candidate = `${base}${extension}`;
      if (isRunnableFile(candidate)) return resolve(candidate);
      if (shadowed === undefined && isRegularFile(candidate)) shadowed = resolve(candidate);
    }
  }

  if (shadowed !== undefined) {
    throw new Error(`command found on PATH but is not executable: ${command} (${shadowed})`);
  }
  throw new Error(`command not found on PATH: ${command}`);
}

/**
 * Build the command line for a batch target; `windowsCommandProcessorArgs` supplies the switches.
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

  // Before resolution and before any child: an environment that names PATH twice cannot be
  // reconciled with the one the child would receive.
  assertUnambiguousWindowsEnvironment(env);

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
        resolveWindowsCommandProcessor(env),
        windowsCommandProcessorArgs(cmdCommandLine(executable, args)),
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
