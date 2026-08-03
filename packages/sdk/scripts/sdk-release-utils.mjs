import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

/**
 * The subprocess wrapper lives in `scripts/release-subprocess.mjs` now: the CLI release path needs
 * the same `ETIMEDOUT` propagation the registry wait depends on, and a second copy of that wrapper
 * is how the two would drift. Re-exported here so the SDK release scripts that already import it
 * keep importing from the same place.
 */
export { runSync } from "../../../scripts/release-subprocess.mjs";

export function computeTarballDigests(tarball) {
  const bytes = readFileSync(tarball);
  return {
    sha1: createHash("sha1").update(bytes).digest("hex"),
    sha256: createHash("sha256").update(bytes).digest("hex"),
    integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
  };
}
