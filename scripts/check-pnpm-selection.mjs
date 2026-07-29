#!/usr/bin/env node
/**
 * Assert that the pnpm on PATH is the one `packageManager` names.
 *
 * `pnpm/action-setup` is given no `version` input anywhere in this repository, so the root
 * manifest's `packageManager` field is the single authority for which pnpm every job runs. That
 * is an invariant of the action's behavior, not of the workflow text: a release that changed how
 * the field is read — or stopped reading it — would still produce a green run, just with a
 * different pnpm resolving the lockfile.
 *
 * Run this after the setup steps and before the first install, on each platform that installs.
 * Node built-ins only: it must work in a job that has not run `pnpm install` yet.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const manifestPath = resolve("package.json");
const { packageManager } = JSON.parse(readFileSync(manifestPath, "utf8"));

if (typeof packageManager !== "string" || !packageManager.startsWith("pnpm@")) {
  console.error(`ERROR: ${manifestPath} must declare a pnpm packageManager, got ${packageManager}`);
  process.exit(1);
}

// `pnpm@10.33.2+sha512...` is valid: Corepack allows a hash suffix. Only the version is compared.
const expected = packageManager.slice("pnpm@".length).split("+")[0];

const actual = execFileSync("pnpm", ["--version"], {
  encoding: "utf8",
  // Windows ships pnpm as a `.cmd` shim, which Node refuses to spawn directly. The command and
  // its arguments are literals, so a shell has nothing here to interpolate.
  shell: process.platform === "win32",
}).trim();

if (actual !== expected) {
  console.error(`ERROR: packageManager selects pnpm ${expected}, but pnpm ${actual} is on PATH`);
  process.exit(1);
}

console.log(`pnpm ${actual} selected from packageManager`);
