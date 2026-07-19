import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

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
    throw wrapped;
  }
}

export function runSync(cmd, args, options = {}) {
  return run(cmd, args, options);
}

export function parseJson(text, label) {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${label} did not contain valid JSON: ${error.message}`);
  }
}

export function computeTarballDigests(tarball) {
  const bytes = readFileSync(tarball);
  return {
    sha1: createHash("sha1").update(bytes).digest("hex"),
    sha256: createHash("sha256").update(bytes).digest("hex"),
    integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
  };
}
