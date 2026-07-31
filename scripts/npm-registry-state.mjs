/**
 * What the public registry currently says about one exact package version.
 *
 * Extracted from `packages/sdk/scripts/npm-registry-state.mjs` when the CLI release path needed the
 * same read. Everything package-specific was one value — the registry arguments — so that is the
 * parameter, and the classification below is shared. It has to be: `absent`, `present`, and
 * `unavailable` are three different answers, the retry logic in `release-registry-wait.mjs` treats
 * them differently, and getting the boundaries wrong is what a second copy would eventually do.
 *
 * Why the registry arguments cannot be a default here: npm resolves a **scoped** package through
 * `@<scope>:registry` before it falls back to `registry`, so `@fairux/sdk` reads must pin both keys
 * and `fairux` — unscoped, with no scope key to override — needs only `--registry`. Pinning a scope
 * key for the CLI would be inert; omitting it for the SDK would let an `.npmrc` line send the read
 * somewhere other than where `npm publish` writes. `scripts/public-npm-registry.mjs` owns both
 * spellings.
 *
 * Node built-ins only: this runs in the privileged publish job, where no dependency tree exists.
 */
import { runSync } from "./release-subprocess.mjs";

function parseRegistryPayload(stdout) {
  const trimmed = stdout.trim();
  if (!trimmed) {
    return { status: "unavailable", reason: "npm view returned empty output" };
  }
  let payload;
  try {
    payload = JSON.parse(trimmed);
  } catch (error) {
    return { status: "unavailable", reason: `npm view returned malformed JSON: ${error.message}` };
  }

  const version = payload.version;
  const shasum = payload.dist?.shasum ?? payload["dist.shasum"];
  const integrity = payload.dist?.integrity ?? payload["dist.integrity"];
  if (typeof version === "string" && typeof shasum === "string" && typeof integrity === "string") {
    return { status: "present", version, shasum, integrity };
  }
  return {
    status: "unavailable",
    reason: `npm view response is missing version, dist.shasum, or dist.integrity`,
  };
}

/**
 * A subprocess the caller's own timeout killed, distinguished from a command that failed.
 *
 * The distinction only matters to a caller that set a timeout, which is why it is carried as a typed
 * error rather than folded into `unavailable` with everything else: a read that ran out the caller's
 * clock is the clock being reached, not the registry being broken.
 */
export class RegistryReadTimeoutError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = "RegistryReadTimeoutError";
    this.isRegistryReadTimeout = true;
    if (cause !== undefined) this.cause = cause;
  }
}

function isSubprocessTimeout(error) {
  // `run` copies `code` off the spawn error; `cause` is checked too so a reader wrapping the
  // helper differently still classifies correctly.
  return error?.code === "ETIMEDOUT" || error?.cause?.code === "ETIMEDOUT";
}

function classifyNpmError(error) {
  const stderr = String(error.stderr ?? error.cause?.stderr ?? "");
  const stdout = String(error.stdout ?? error.cause?.stdout ?? "");
  const combined = `${stdout}\n${stderr}`;
  if (/\bE404\b|404 Not Found|is not in this registry/i.test(combined)) {
    return { status: "absent" };
  }
  const reason =
    combined
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(0, 4)
      .join(" ") || error.message;
  return { status: "unavailable", reason };
}

/**
 * @param {string} spec  `fairux@0.1.0-beta.1` or `@fairux/sdk@0.1.0-beta.2`
 * @param {object} options
 * @param {readonly string[]} options.registryArgs  from `scripts/public-npm-registry.mjs`
 * @param {(cmd: string, args: string[], options?: object) => string} [options.run]
 * @param {boolean} [options.throwOnReadError]  when true, only `E404` becomes `absent` and every
 *   other command, network, auth, or timeout failure is raised instead of being reported as
 *   `unavailable`. Callers that retry need that difference: `unavailable` is a statement about the
 *   registry's answer, and a killed or unauthenticated `npm view` is not an answer.
 */
export function readNpmRegistryState(spec, options) {
  const { registryArgs, run = runSync, throwOnReadError = false } = options ?? {};
  if (!Array.isArray(registryArgs) || registryArgs.length === 0) {
    throw new TypeError("readNpmRegistryState requires registryArgs naming the registry to read");
  }
  try {
    // The registry is named here, not resolved from npm config.
    const stdout = run("npm", [
      "view",
      spec,
      "version",
      "dist.shasum",
      "dist.integrity",
      "--json",
      ...registryArgs,
    ]);
    return parseRegistryPayload(stdout);
  } catch (error) {
    // Process-level first. A killed subprocess is a fact about the process; whatever npm managed to
    // write before it died is a fragment. Classifying the text first made a timeout whose partial
    // stderr happened to contain `E404` report as `absent` — a read that never finished, answering
    // "the version is not there".
    if (throwOnReadError && isSubprocessTimeout(error)) {
      throw new RegistryReadTimeoutError(
        `npm view of ${spec} exceeded the caller's timeout`,
        error,
      );
    }
    const classified = classifyNpmError(error);
    if (throwOnReadError && classified.status !== "absent") {
      throw error;
    }
    return classified;
  }
}
