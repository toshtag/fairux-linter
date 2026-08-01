#!/usr/bin/env node
/**
 * Prove the beta channel points at the version this run is about to announce.
 *
 * The release path verifies the *version's* digest and never reads the dist-tags. That gap is only
 * reachable on a rerun: `release-registry-plan.mjs` finds the version already present with a
 * matching digest, sets `PUBLISH_NEEDED=false`, and skips the publish — correctly, because npm never
 * lets a name/version pair be reused. But `next` may have moved to something else in between, and
 * the Release notes then tell a reader
 *
 *     npm install @fairux/sdk@next
 *
 * for a beta that is no longer on that channel. Every digest check in the run passes while the one
 * instruction a consumer actually follows is wrong.
 *
 * So this runs after the digest verification and **before the notes are written**: a claim made
 * before the check that supports it is a claim the run has not earned.
 *
 * Three assertions, and each is a different mistake:
 *
 * - `next` names this version — the channel the notes tell people to install from.
 * - `latest` does **not** name it — a beta reaching `latest` is a publication decision nobody made,
 *   and it is what `npm install @fairux/sdk` gives an unsuspecting consumer.
 * - `bootstrap` is unchanged — it is the name-reservation record and is never retired.
 *
 * It does not repair anything. Moving a dist-tag back is a publication decision, and a workflow that
 * quietly re-pointed a channel would be making one.
 *
 * Node built-ins only: this runs in the privileged publish job.
 */
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { NPM_SDK_VIEW_REGISTRY_ARGS } from "../../../scripts/public-npm-registry.mjs";
import { runSync } from "../../../scripts/release-subprocess.mjs";
import { SDK_PACKAGE_NAME } from "./release-notes.mjs";

/** The dist-tag a beta publishes to. Stable releases use `latest`; this path is beta-only. */
export const SDK_BETA_CHANNEL = "next";

/** The name-reservation tag, never retired by a later release. */
export const SDK_BOOTSTRAP_TAG = "bootstrap";

/**
 * What the dist-tags must say once a beta version is published.
 *
 * Pure: the caller reads the registry, this decides what the reading means.
 *
 * @param {{distTags: unknown, version: string, channel?: string}} input
 * @returns {string[]} failures; empty means the channel points where the notes say it does
 */
export function auditSdkDistTags({ distTags, version, channel = SDK_BETA_CHANNEL }) {
  if (typeof distTags !== "object" || distTags === null || Array.isArray(distTags)) {
    return ["npm view dist-tags did not return an object"];
  }
  const tags = /** @type {Record<string, unknown>} */ (distTags);
  const failures = [];

  if (tags[channel] !== version) {
    failures.push(
      `dist-tag ${channel} names ${JSON.stringify(tags[channel])}, not ${version} — the release ` +
        `notes tell a reader to install ${SDK_PACKAGE_NAME}@${channel}, and that would give them ` +
        "a different version",
    );
  }

  // A beta on `latest` is what `npm install @fairux/sdk` gives someone who asked for nothing in
  // particular. Nobody decided that, so nothing may do it silently.
  if (tags.latest === version) {
    failures.push(
      `dist-tag latest names ${version}. A beta reaching latest is a publication decision, and ` +
        "this release did not make one",
    );
  }

  if (tags[SDK_BOOTSTRAP_TAG] === version) {
    failures.push(
      `dist-tag ${SDK_BOOTSTRAP_TAG} names ${version}. It records the name reservation and is ` +
        "never retired by a later release",
    );
  }

  return failures;
}

/**
 * Compare the dist-tags before and after publishing, when a before-reading was taken.
 *
 * The check above is what must hold; this is what must not have *changed*. A run that moved a tag it
 * was never asked to move is a run that made a decision on someone's behalf, and the difference is
 * only visible against a prior reading.
 *
 * @param {{before: unknown, after: unknown, channel?: string}} input
 * @returns {string[]}
 */
export function auditUnchangedDistTags({ before, after, channel = SDK_BETA_CHANNEL }) {
  if (typeof before !== "object" || before === null) return [];
  const previous = /** @type {Record<string, unknown>} */ (before);
  const current = /** @type {Record<string, unknown>} */ (after ?? {});
  const failures = [];

  for (const [tag, value] of Object.entries(previous)) {
    if (tag === channel) continue;
    if (current[tag] !== value) {
      failures.push(
        `dist-tag ${tag} moved from ${JSON.stringify(value)} to ${JSON.stringify(current[tag])}; ` +
          `this release was only asked to move ${channel}`,
      );
    }
  }
  for (const tag of Object.keys(current)) {
    if (!(tag in previous))
      failures.push(`dist-tag ${tag} appeared, and this release did not add it`);
  }
  return failures;
}

function option(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const version = option("--version");
  const channel = option("--dist-tag") ?? SDK_BETA_CHANNEL;
  if (!version) {
    console.error("Usage: verify-sdk-dist-tags.mjs --version <version> [--dist-tag <tag>]");
    process.exit(2);
  }

  let distTags;
  try {
    const raw = runSync("npm", [
      "view",
      SDK_PACKAGE_NAME,
      "dist-tags",
      "--json",
      ...NPM_SDK_VIEW_REGISTRY_ARGS,
    ]);
    distTags = JSON.parse(raw.trim() || "{}");
  } catch (error) {
    // A failed read is not a passing check. The publish already happened; this run must still go red.
    console.error(`ERROR: could not read dist-tags for ${SDK_PACKAGE_NAME}: ${error.message}`);
    process.exit(1);
  }

  const failures = auditSdkDistTags({ distTags, version, channel });
  if (failures.length > 0) {
    console.error(`\n✖ ${SDK_PACKAGE_NAME} dist-tags are not what this release announces:\n`);
    for (const failure of failures) console.error(`  - ${failure}`);
    console.error(
      "\nNothing was changed. Moving a dist-tag is a publication decision; see " +
        "docs/sdk-beta-release.md.",
    );
    process.exit(1);
  }

  console.log(`✓ dist-tag ${channel} names ${version}, and latest and bootstrap do not`);
}
