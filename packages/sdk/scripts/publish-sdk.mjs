#!/usr/bin/env node
/**
 * The one place `npm publish` is called for `@fairux/sdk`.
 *
 * The flags used to live in a multi-line shell block in `publish-sdk.yml`, and `release-check.mjs`
 * guarded them by slicing the workflow text from the first `npm publish` and searching the rest.
 * Measured: deleting `--ignore-scripts` from the command and writing it in a comment *after* the
 * block passed that check. So did every other flag, the same way. A guarantee that a comment can
 * satisfy is not a guarantee.
 *
 * Moving the arguments here makes them data rather than prose. `buildSdkPublishArgs` is pure and
 * exported, so the tests assert the exact argv the registry will see — not a description of it —
 * and the workflow's only remaining job is to call this file.
 *
 * Node built-ins and repository-local helpers only: this runs in the publish job, which installs
 * nothing. No shell, either — the arguments go to `execFileSync` as an array, so no value here can
 * be word-split or interpreted. That is not hypothetical for this repository: a `distTag` of
 * `next'; touch /tmp/PWNED; echo '` once executed in this job, back when a script printed shell
 * assignments for it to `eval`.
 */

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { NPM_SDK_PUBLISH_REGISTRY_ARGS } from "../../../scripts/public-npm-registry.mjs";

/** The dist-tag a beta SDK release is allowed to move. `latest` is not this workflow's to touch. */
export const SDK_PUBLISH_DIST_TAG = "next";

/**
 * The exact argv for `npm publish`.
 *
 * Pure and total: it either returns the arguments or throws. Order is fixed so a test can assert
 * the whole array rather than membership — membership is what the old workflow check asserted, and
 * membership cannot tell `--tag next <tarball>` from `--tag <tarball> next`.
 *
 * @param {{ distTag: string, tarball: string }} input
 * @returns {string[]}
 */
export function buildSdkPublishArgs({ distTag, tarball }) {
  assertInert("dist-tag", distTag);
  assertInert("tarball", tarball);

  if (distTag !== SDK_PUBLISH_DIST_TAG) {
    throw new Error(
      `SDK publishes on the ${SDK_PUBLISH_DIST_TAG} dist-tag; refusing to publish on ${distTag}`,
    );
  }
  if (!isAbsolute(tarball)) {
    throw new Error(`tarball must be an absolute path, got ${tarball}`);
  }
  if (!/^fairux-sdk-\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?\.tgz$/.test(basename(tarball))) {
    throw new Error(`tarball is not a packed @fairux/sdk archive: ${tarball}`);
  }

  return [
    "publish",
    // Both keys, because `@fairux/sdk` is scoped: npm resolves a scoped package through
    // `@fairux:registry` first and only falls back to `registry`, so `--registry` alone leaves any
    // `@fairux:registry=` line in the config chain in charge of where this publish goes.
    ...NPM_SDK_PUBLISH_REGISTRY_ARGS,
    // The tarball was packed and audited already; nothing in it may run here.
    "--ignore-scripts",
    "--provenance",
    "--access",
    "public",
    "--tag",
    distTag,
    tarball,
  ];
}

/** Whether the plan step decided a publish is needed. Only two spellings are accepted. */
export function parsePublishNeeded(value) {
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`PUBLISH_NEEDED must be "true" or "false", got ${JSON.stringify(value)}`);
}

/**
 * Run the publication.
 *
 * @param {{
 *   env: NodeJS.ProcessEnv,
 *   run?: (file: string, args: string[], options: object) => unknown,
 *   log?: (message: string) => void,
 *   exists?: (path: string) => boolean,
 * }} options
 * @returns {{ published: boolean, args: string[] | null }}
 */
export function publishSdk({ env, run = defaultRun, log = console.log, exists = existsSync }) {
  if (!parsePublishNeeded(env.PUBLISH_NEEDED)) {
    // Skipped without touching npm at all — not even to be told the version is there. The plan step
    // already read the registry and found this exact version with a matching digest.
    log(`${env.SPEC ?? "@fairux/sdk"} already exists with matching digest; skipping npm publish.`);
    return { published: false, args: null };
  }

  const args = buildSdkPublishArgs({ distTag: env.DIST_TAG, tarball: env.TARBALL });
  const tarball = args[args.length - 1];
  if (!exists(tarball)) throw new Error(`tarball does not exist: ${tarball}`);

  log(`npm ${args.join(" ")}`);
  run("npm", args, { stdio: "inherit" });
  return { published: true, args };
}

/** Values reaching npm must be single, inert arguments. */
function assertInert(label, value) {
  if (typeof value !== "string" || value === "") {
    throw new Error(`${label} is required`);
  }
  if (/[\0\r\n]/.test(value)) {
    throw new Error(`${label} contains a newline or NUL: ${JSON.stringify(value)}`);
  }
}

/** `basename` without importing it twice; the path separator here is always POSIX in CI. */
function basename(path) {
  const at = path.lastIndexOf("/");
  return at === -1 ? path : path.slice(at + 1);
}

function defaultRun(file, args, options) {
  return execFileSync(file, args, options);
}

// Entry point, in this repository's idiom — so importing this module from a test runs nothing.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    publishSdk({ env: process.env });
  } catch (error) {
    console.error(`✗ ${error.message}`);
    process.exit(1);
  }
}
