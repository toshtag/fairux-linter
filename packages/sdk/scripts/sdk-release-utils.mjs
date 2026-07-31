import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

/**
 * `run`, `runSync`, and the timeout live in `scripts/release-subprocess.mjs` now: the CLI release
 * path needs the same `ETIMEDOUT` propagation the registry wait depends on, and a second copy of
 * that wrapper is how the two would drift. Re-exported here so every existing caller and test keeps
 * importing from the same place.
 */
export { DEFAULT_TIMEOUT, run, runSync } from "../../../scripts/release-subprocess.mjs";

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
