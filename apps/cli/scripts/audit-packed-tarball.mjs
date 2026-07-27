#!/usr/bin/env node
/**
 * Audit a packed `fairux` tarball's contents from a trusted checkout.
 *
 * Run in the privileged publish job against the downloaded bundle, using this repository's own
 * auditor rather than anything shipped alongside the artifact. Node built-ins and `tar` only —
 * no install, no CLI execution, no network.
 */
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { auditPackedCliTarball } from "./packed-tarball-contract.mjs";

const tarball = process.env.TARBALL;
if (!tarball) {
  console.error("ERROR: TARBALL is required");
  process.exit(1);
}

const cliDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const failures = auditPackedCliTarball({
  tarball: resolve(tarball),
  sourceManifestPath: resolve(cliDir, "package.json"),
  run: (cmd, args) => execFileSync(cmd, args, { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 }),
  onPass: (message) => console.log(`✓ ${message}`),
});

if (failures.length > 0) {
  console.error("\n✖ packed tarball failed the structural contract:\n");
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

console.log("\n✓ packed tarball satisfies the structural contract");
