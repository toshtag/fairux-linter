#!/usr/bin/env node
/**
 * Fail-closed preflight for an npm Trusted Publishing job.
 *
 * Gathers every npm config that applies to the publish, plus the environment, and hands them to
 * `trusted-publishing-contract.mjs` — which explains why each condition exists and which real
 * failure it encodes.
 *
 * Run it twice: once early, so a misconfigured job fails before packing and auditing, and once
 * immediately before `npm publish`, because everything in between — `pnpm install`, lifecycle
 * scripts, `GITHUB_ENV` writes — can introduce a credential the early run could not have seen.
 *
 * It prints the npm version, the resolved registry, and which config files were inspected. It
 * never prints a token, an OIDC value, a config file's contents, or `npm config list`.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { assessTrustedPublishing } from "./trusted-publishing-contract.mjs";

const npmConfig = (key) => execFileSync("npm", ["config", "get", key], { encoding: "utf8" }).trim();

/**
 * Read one npm config file.
 *
 * Absent is a legitimate answer. Any other error is not: a config we cannot read is a config we
 * cannot clear, and passing on it would be the fail-open this check exists to prevent.
 */
function readConfigSource(kind, path) {
  if (!path || path === "undefined" || path === "null") return null;
  const resolved = resolve(path);
  try {
    return { kind, path: resolved, contents: readFileSync(resolved, "utf8") };
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw new Error(
      `Cannot read the ${kind} npm config at ${resolved}: ${error?.code ?? "unknown error"}. ` +
        "Refusing to publish rather than assume it holds no credential.",
      { cause: error },
    );
  }
}

const npmVersion = execFileSync("npm", ["--version"], { encoding: "utf8" }).trim();
const registry = npmConfig("registry");

// npm layers project over user over global. The project file is the one the earlier version of
// this check missed entirely — a placeholder at the repository root passed it.
const candidates = [
  ["project", resolve(process.cwd(), ".npmrc")],
  ["user", npmConfig("userconfig")],
  ["global", npmConfig("globalconfig")],
];

const configSources = [];
const seen = new Set();
for (const [kind, path] of candidates) {
  const source = readConfigSource(kind, path);
  if (!source || seen.has(source.path)) continue;
  seen.add(source.path);
  configSources.push(source);
}

console.log(`node ${process.versions.node}`);
console.log(`npm ${npmVersion}`);
console.log(`registry ${registry}`);
console.log(
  configSources.length === 0
    ? "npm config files: none present"
    : `npm config files: ${configSources.map((s) => `${s.kind} (${s.path})`).join(", ")}`,
);

// The builtin npmrc shipped inside the npm installation is not inspected: it is immutable package
// data, not something this job or this repository can set.

const { ok, failures } = assessTrustedPublishing({ npmVersion, env: process.env, configSources });

if (!ok) {
  console.error("\n✖ npm Trusted Publishing preconditions not met:\n");
  for (const failure of failures) console.error(`  - ${failure}`);
  console.error(
    "\nRefusing to publish. This does not un-consume the tag — the workflow is tag-triggered, so" +
      "\nthe tag already exists — but it stops before the tarball is built and before the registry" +
      "\nis contacted with a credential state that cannot work.",
  );
  process.exit(1);
}

console.log("\n✓ Local Trusted Publishing prerequisites present: OIDC available, no credential in");
console.log("  the environment or in any applicable npm config.");
console.log("  (This does not prove a matching Trusted Publisher record exists on npm.)");
