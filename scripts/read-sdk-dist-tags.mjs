#!/usr/bin/env node
import { SDK_PACKAGE_NAME } from "../packages/sdk/scripts/release-notes.mjs";
/**
 * Print `@fairux/sdk`'s current dist-tags as JSON, for the pre-publish snapshot.
 *
 * A separate entry point rather than a `npm view` line in the workflow, so the registry pinning is
 * the one `public-npm-registry.mjs` owns: `@fairux/sdk` is scoped, and npm resolves it through
 * `@fairux:registry` before falling back to `registry`. A snapshot taken from a different host than
 * the publish writes to would make the comparison meaningless while looking identical.
 *
 * Fail-closed. An unreadable registry, empty output, or a response that is not a dist-tag map all
 * exit non-zero: the comparison this feeds cannot happen without a trustworthy before-reading, and
 * "could not read" must never become "nothing changed".
 */
import { NPM_SDK_VIEW_REGISTRY_ARGS } from "./public-npm-registry.mjs";
import { runSync } from "./release-subprocess.mjs";

try {
  const raw = runSync("npm", [
    "view",
    SDK_PACKAGE_NAME,
    "dist-tags",
    "--json",
    ...NPM_SDK_VIEW_REGISTRY_ARGS,
  ]);
  const trimmed = raw.trim();
  if (trimmed === "") {
    console.error(`ERROR: npm returned no dist-tags for ${SDK_PACKAGE_NAME}`);
    process.exit(1);
  }
  const parsed = JSON.parse(trimmed);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    console.error(`ERROR: npm returned a non-object dist-tag response for ${SDK_PACKAGE_NAME}`);
    process.exit(1);
  }
  process.stdout.write(`${JSON.stringify(parsed, null, 2)}\n`);
} catch (error) {
  console.error(`ERROR: could not read dist-tags for ${SDK_PACKAGE_NAME}: ${error.message}`);
  process.exit(1);
}
