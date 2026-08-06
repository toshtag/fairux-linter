import { execFileSync } from "node:child_process";
import {
  isQuotableForCmd,
  resolveCommand,
  resolveWindowsCommandProcessor,
  windowsCommandProcessorArgs,
} from "./run-command.mjs";

/**
 * The one way a release script runs a subprocess.
 *
 * Extracted from `packages/sdk/scripts/sdk-release-utils.mjs` when the CLI release path needed the
 * same guarantees. It is here rather than duplicated because the one property that matters is easy
 * to lose in a copy: `code` is carried off the spawn error, and `code === "ETIMEDOUT"` is the only
 * way a caller can tell a subprocess its own timeout killed from a command that failed on its own.
 * The registry wait depends on that distinction — a killed read is the deadline being reached, a
 * failed read is a broken registry — and an earlier version that dropped `code` made the `timeout`
 * option decorative: the wrapper looked like every other failure.
 *
 * **The command is resolved before it is spawned**, through the same rules `run-command.mjs` owns.
 * This called `execFileSync("npm", …)` directly, which is not portable: on Windows the `npm` on
 * `PATH` is `npm.cmd`, a batch file `CreateProcess` will not launch and Node refuses to try since
 * the CVE-2024-27980 fix. Both Windows cells of `registry-cli-smoke.yml` therefore failed at their
 * first `npm view`, in about a tenth of a second, reporting `status: unavailable` — a spawn failure
 * wearing the same words as an absent package, which is why it survived the whole period when the
 * package really was absent. The resolution and the `cmd.exe` quoting rule are not reimplemented
 * here; only the error contract above is this module's own.
 *
 * Node built-ins only, on both sides. Both publish jobs run scripts that reach this while no
 * dependency tree exists.
 */
export const DEFAULT_TIMEOUT = 120_000;

export function run(cmd, args, options = {}) {
  const { timeout = DEFAULT_TIMEOUT, env = {}, ...execOptions } = options;
  const childEnv = { ...process.env, ...env };
  try {
    // Resolved against the environment the child will run in, so the binary that is found and the
    // `PATH` it runs under are decided together — `run-command.mjs` argues that at length.
    const executable = resolveCommand(cmd, {
      cwd: execOptions.cwd ?? process.cwd(),
      env: childEnv,
    });
    const needsCmd =
      process.platform === "win32" &&
      [".cmd", ".bat"].some((extension) => executable.toLowerCase().endsWith(extension));
    const spawnOptions = {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout,
      maxBuffer: 32 * 1024 * 1024,
      env: childEnv,
      ...execOptions,
    };
    if (!needsCmd) return execFileSync(executable, args, spawnOptions);

    // The one place a shell is involved, with the command line built under one quoting rule and an
    // argument that rule cannot express refused rather than escaped approximately.
    for (const argument of [executable, ...args]) {
      if (!isQuotableForCmd(argument)) {
        throw new Error(
          `refusing to run ${cmd} through cmd.exe: an argument contains a character that cannot ` +
            `be quoted safely (%, ", CR, LF, or NUL)`,
        );
      }
    }
    const commandLine = `"${[executable, ...args].map((argument) => `"${argument}"`).join(" ")}"`;
    return execFileSync(
      resolveWindowsCommandProcessor(childEnv),
      windowsCommandProcessorArgs(commandLine),
      { ...spawnOptions, windowsVerbatimArguments: true },
    );
  } catch (error) {
    const stdout = String(error.stdout ?? "");
    const stderr = String(error.stderr ?? "");
    const wrapped = new Error(
      [
        `${cmd} ${args.join(" ")} failed`,
        // The cause's own message, when the child produced no output to explain itself. A command
        // that was never spawned — not on `PATH`, or an argument `cmd.exe` cannot carry — has only
        // this, and without it the wrapper reported the same bare sentence for every failure.
        !stdout && !stderr && error.message ? error.message : undefined,
        stdout ? `stdout:\n${stdout}` : undefined,
        stderr ? `stderr:\n${stderr}` : undefined,
      ]
        .filter(Boolean)
        .join("\n"),
    );
    wrapped.cause = error;
    wrapped.stdout = stdout;
    wrapped.stderr = stderr;
    wrapped.status = error.status;
    wrapped.signal = error.signal;
    wrapped.code = error.code;
    throw wrapped;
  }
}

/** The synchronous alias the release scripts call. Same function; the name states the intent. */
export function runSync(cmd, args, options = {}) {
  return run(cmd, args, options);
}
