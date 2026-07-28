#!/usr/bin/env node
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { NPM_SDK_VIEW_REGISTRY_ARGS } from "../../../scripts/public-npm-registry.mjs";
import { runSync } from "./sdk-release-utils.mjs";

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
  // `runSync` copies `code` off the spawn error; `cause` is checked too so a reader wrapping the
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
 * @param {string} spec
 * @param {object} [options]
 * @param {(cmd: string, args: string[], options?: object) => string} [options.run]
 * @param {boolean} [options.throwOnReadError]  when true, only `E404` becomes `absent` and every
 *   other command, network, auth, or timeout failure is raised instead of being reported as
 *   `unavailable`. Callers that retry need that difference: `unavailable` is a statement about the
 *   registry's answer, and a killed or unauthenticated `npm view` is not an answer.
 */
export function getNpmRegistryState(spec, options = {}) {
  const run = options.run ?? runSync;
  try {
    // The registry is named here, not resolved from npm config — and both the fallback key and the
    // `@fairux:` scope key are pinned, because npm resolves a scoped package through the scope key
    // first. `--registry` alone leaves a `@fairux:registry=` line in any `.npmrc` in charge, which
    // would point this read somewhere other than where `npm publish` writes.
    const stdout = run("npm", [
      "view",
      spec,
      "version",
      "dist.shasum",
      "dist.integrity",
      "--json",
      ...NPM_SDK_VIEW_REGISTRY_ARGS,
    ]);
    return parseRegistryPayload(stdout);
  } catch (error) {
    // Process-level first. A killed subprocess is a fact about the process; whatever npm managed to
    // write before it died is a fragment. Classifying the text first made a timeout whose partial
    // stderr happened to contain `E404` report as `absent` — a read that never finished, answering
    // "the version is not there".
    if (options.throwOnReadError && isSubprocessTimeout(error)) {
      throw new RegistryReadTimeoutError(
        `npm view of ${spec} exceeded the caller's timeout`,
        error,
      );
    }
    const classified = classifyNpmError(error);
    if (options.throwOnReadError && classified.status !== "absent") {
      throw error;
    }
    return classified;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const specIndex = process.argv.indexOf("--spec");
  const spec = specIndex >= 0 ? process.argv[specIndex + 1] : process.argv[2];
  if (!spec) {
    console.error("Usage: npm-registry-state.mjs --spec @fairux/sdk@<version>");
    process.exit(2);
  }
  const state = getNpmRegistryState(spec);
  console.log(JSON.stringify(state, null, 2));
  process.exitCode = state.status === "unavailable" ? 1 : 0;
}
