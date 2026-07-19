#!/usr/bin/env node
import { copyFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const sdkDir = resolve(here, "..");
const repoRoot = resolve(sdkDir, "..", "..");

for (const name of ["LICENSE", "NOTICE"]) {
  const src = resolve(repoRoot, name);
  if (!existsSync(src)) {
    console.error(`copy-publish-assets: missing ${src}`);
    process.exit(1);
  }
  copyFileSync(src, resolve(sdkDir, name));
}
