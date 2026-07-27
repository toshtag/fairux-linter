#!/usr/bin/env node
/**
 * Fail-closed preflight for an npm Trusted Publishing job.
 *
 * Run this in a publish job after `actions/setup-node` and before anything expensive. It refuses
 * to continue unless npm can actually perform the OIDC exchange — see
 * `trusted-publishing-contract.mjs` for why each condition exists and which real failure it
 * encodes.
 *
 * It prints the npm version, the resolved registry, and whether a user config exists. It never
 * prints a token, an OIDC value, an npm config file's contents, or `npm config list`.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { assessTrustedPublishing } from "./trusted-publishing-contract.mjs";

const npmConfig = (key) => execFileSync("npm", ["config", "get", key], { encoding: "utf8" }).trim();

const npmVersion = execFileSync("npm", ["--version"], { encoding: "utf8" }).trim();
const registry = npmConfig("registry");
const userconfig = npmConfig("userconfig");
const userconfigExists = userconfig !== "" && userconfig !== "undefined" && existsSync(userconfig);
const npmrcContents = userconfigExists ? readFileSync(userconfig, "utf8") : null;

console.log(`node ${process.versions.node}`);
console.log(`npm ${npmVersion}`);
console.log(`registry ${registry}`);
console.log(`npm user config ${userconfigExists ? "present" : "absent"}`);

const { ok, failures } = assessTrustedPublishing({
  npmVersion,
  env: process.env,
  npmrcContents,
});

if (!ok) {
  console.error("\n✖ npm Trusted Publishing preconditions not met:\n");
  for (const failure of failures) console.error(`  - ${failure}`);
  console.error(
    "\nRefusing to publish. A tag is consumed by a failed attempt and cannot be moved,\n" +
      "so this stops before the tarball is built rather than after the registry rejects it.",
  );
  process.exit(1);
}

console.log("\n✓ npm Trusted Publishing preconditions met (OIDC available, no static credential).");
