#!/usr/bin/env node
// Copy the repo-root LICENSE, NOTICE, and README into apps/cli before packing, so the published
// `fairux` tarball is self-contained (npm includes a package's own files, not parent-dir ones).
// Run from prepack; the copies are .gitignored and recreated each pack.
import { copyFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const cliDir = resolve(here, "..");
const repoRoot = resolve(cliDir, "..", "..");

for (const name of ["LICENSE", "NOTICE", "README.md"]) {
  const src = resolve(repoRoot, name);
  if (!existsSync(src)) {
    console.error(`copy-publish-assets: missing ${src}`);
    process.exit(1);
  }
  copyFileSync(src, resolve(cliDir, name));
}
