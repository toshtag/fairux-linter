import { execFileSync } from "node:child_process";

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
 * Node built-ins only. Both publish jobs run scripts that reach this while no dependency tree
 * exists.
 */
export const DEFAULT_TIMEOUT = 120_000;

export function run(cmd, args, options = {}) {
  const { timeout = DEFAULT_TIMEOUT, env = {}, ...execOptions } = options;
  try {
    return execFileSync(cmd, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout,
      maxBuffer: 32 * 1024 * 1024,
      env: { ...process.env, ...env },
      ...execOptions,
    });
  } catch (error) {
    const stdout = String(error.stdout ?? "");
    const stderr = String(error.stderr ?? "");
    const wrapped = new Error(
      [
        `${cmd} ${args.join(" ")} failed`,
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
