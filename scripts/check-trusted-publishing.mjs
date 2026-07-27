#!/usr/bin/env node
/**
 * Fail-closed preflight for an npm Trusted Publishing job.
 *
 * Gathers every npm config that applies to the publish, plus the environment, and hands them to
 * `trusted-publishing-contract.mjs` — which explains why each condition exists and which real
 * failure it encodes.
 *
 * Run it **once**, in the privileged publish job, in the step immediately before `npm publish`.
 * That position is the guarantee: the tarball was already prepared by an unprivileged job, and the
 * publish job installs nothing and runs no lifecycle script, so nothing can introduce a credential
 * between this check and the publish it guards. Running it earlier as well would prove less, not
 * more — an early pass says nothing about the state at publish time.
 *
 * It prints the npm version, the resolved registry, and which config files were inspected. It
 * never prints a token, an OIDC value, a config file's contents, or `npm config list`.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { collectNpmConfigSources } from "./trusted-publishing-config-sources.mjs";
import { assessTrustedPublishing } from "./trusted-publishing-contract.mjs";

const npmConfig = (key) => execFileSync("npm", ["config", "get", key], { encoding: "utf8" }).trim();

const npmVersion = execFileSync("npm", ["--version"], { encoding: "utf8" }).trim();
const registry = npmConfig("registry");

// The builtin npmrc shipped inside the npm installation is not inspected: it is immutable package
// data, not something this job or this repository can set.
const configSources = collectNpmConfigSources({
  cwd: process.cwd(),
  npmConfigGet: npmConfig,
  readFile: (path) => readFileSync(path, "utf8"),
  resolvePath: (path) => resolve(path),
});

console.log(`node ${process.versions.node}`);
console.log(`npm ${npmVersion}`);
console.log(`registry ${registry}`);
console.log(
  configSources.length === 0
    ? "npm config files: none present"
    : `npm config files: ${configSources.map((s) => `${s.kind} (${s.path})`).join(", ")}`,
);

const { ok, failures } = assessTrustedPublishing({ npmVersion, env: process.env, configSources });

if (!ok) {
  console.error("\n✖ npm Trusted Publishing preconditions not met:\n");
  for (const failure of failures) console.error(`  - ${failure}`);
  console.error(
    "\nRefusing to publish. This does not un-consume the tag — the workflow is tag-triggered, so" +
      "\nthe tag already exists, and the tarball was built by an earlier job — but it stops before" +
      "\nthe registry is contacted with a credential state that cannot work.",
  );
  process.exit(1);
}

console.log("\n✓ Local Trusted Publishing prerequisites present: OIDC available, no credential in");
console.log("  the environment or in any applicable npm config.");
console.log("  (This does not prove a matching Trusted Publisher record exists on npm.)");
