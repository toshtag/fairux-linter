/**
 * The version each workspace package declares, read from the trusted checkout.
 *
 * `pnpm pack` resolves a `workspace:*` range to the referenced package's own version, so verifying
 * a published manifest means knowing those versions — from the checkout, never from the tarball.
 *
 * Node built-ins only, and no dependency on the workspace tooling: this runs in the privileged
 * publish job, where no `node_modules` exists.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Directories holding workspace packages. Mirrors `pnpm-workspace.yaml`. */
const WORKSPACE_ROOTS = Object.freeze(["packages", "apps"]);

/**
 * @param {string} repoRoot
 * @returns {Record<string, string>} package name → declared version
 */
export function workspaceVersions(repoRoot) {
  const versions = {};
  for (const root of WORKSPACE_ROOTS) {
    let entries;
    try {
      entries = readdirSync(join(repoRoot, root), { withFileTypes: true });
    } catch (error) {
      // A missing workspace root means the checkout is not what this script assumes. Fail rather
      // than return a map that is quietly short a package.
      throw new Error(`cannot read workspace root ${root}: ${error.message}`);
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      let manifest;
      try {
        manifest = JSON.parse(
          readFileSync(join(repoRoot, root, entry.name, "package.json"), "utf8"),
        );
      } catch {
        continue; // not a package directory
      }
      if (typeof manifest.name === "string" && typeof manifest.version === "string") {
        versions[manifest.name] = manifest.version;
      }
    }
  }
  return versions;
}
