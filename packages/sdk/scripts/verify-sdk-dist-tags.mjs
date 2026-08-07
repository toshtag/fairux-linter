#!/usr/bin/env node
/**
 * Read `@fairux/sdk`'s dist-tags from the public registry and hold them to the channel policy.
 *
 * Runs twice in the privileged publish job, and the two runs are not the same check.
 *
 * `--phase before-publish` runs after the publication plan and **before** `npm publish`. It is the
 * only one that can still refuse: npm never lets a name/version pair be reused, so an unexpected
 * `latest` found after the publish is found once the version is permanently spent. It needs the
 * plan's `--publish-needed`, because that decides what this release's channel is allowed to be.
 * The SDK path had no such phase — it verified the channel only after the write, which is a rule it
 * could state and not keep.
 *
 * `--phase after-publish` runs after the registry digest has been verified, and before the notes
 * are written. The digest proves the right bytes are on npm; this proves they are reachable at the
 * channel the release announced, which is the one instruction a consumer actually follows. The gap
 * is reachable on a rerun: the plan finds the version already present with a matching digest, skips
 * the publish — correctly — and the channel may have moved in between. It additionally compares
 * against a reading taken before the publish, so "this release moved one channel and nothing else"
 * is a measurement rather than an inference from current values.
 *
 * Read-only in both phases. It never runs `npm dist-tag add` or `npm dist-tag rm`: a channel this
 * workflow did not publish to is the owner's, and one that rewrote registry state to make its own
 * check pass would be reporting on itself.
 *
 * Node built-ins only: this runs in the privileged publish job.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { NPM_SDK_VIEW_REGISTRY_ARGS } from "../../../scripts/public-npm-registry.mjs";
import { runSync } from "../../../scripts/release-subprocess.mjs";
import {
  auditSdkDistTagsAfterPublish,
  auditSdkDistTagsBeforePublish,
  auditUnchangedDistTags,
  SDK_DIST_TAG_PHASES,
} from "./sdk-dist-tag-contract.mjs";
import { SDK_PACKAGE_NAME, SDK_RUNBOOK } from "./sdk-release-contract.mjs";

/**
 * Read the before-publication snapshot, refusing anything that is not one.
 *
 * Fail-closed on every failure mode. A missing or unreadable snapshot means the comparison cannot
 * happen, and "cannot compare" must never quietly become "nothing changed" — that is precisely the
 * silence this check exists to remove.
 *
 * @param {string} filePath
 * @returns {{distTags: Record<string, unknown>} | {error: string}}
 */
export function readDistTagSnapshot(filePath) {
  let contents;
  try {
    contents = readFileSync(filePath, "utf8");
  } catch (error) {
    return {
      error: `could not read the pre-publish dist-tag snapshot ${filePath}: ${error.message}`,
    };
  }
  if (contents.trim() === "") {
    return { error: `the pre-publish dist-tag snapshot ${filePath} is empty` };
  }
  let parsed;
  try {
    parsed = JSON.parse(contents);
  } catch (error) {
    return { error: `the pre-publish dist-tag snapshot ${filePath} is not JSON: ${error.message}` };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { error: `the pre-publish dist-tag snapshot ${filePath} is not a dist-tag map` };
  }
  return { distTags: parsed };
}

/**
 * `npm view <pkg> dist-tags --json`, not `npm dist-tag ls`.
 *
 * `npm dist-tag ls` prints `tag: version` lines with no machine-readable mode, so reading it means
 * parsing prose. `npm view … --json` returns the same map as JSON, through the same registry
 * arguments as every other read in the release path — both keys, because a scoped package resolves
 * through `@fairux:registry` first.
 */
function readDistTags(spec) {
  const stdout = runSync("npm", [
    "view",
    spec,
    "dist-tags",
    "--json",
    ...NPM_SDK_VIEW_REGISTRY_ARGS,
  ]);
  const trimmed = stdout.trim();
  if (!trimmed) throw new Error(`npm view ${spec} dist-tags returned empty output`);
  const parsed = JSON.parse(trimmed);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`npm view ${spec} dist-tags did not return an object`);
  }
  return parsed;
}

function option(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const USAGE =
  "Usage: verify-sdk-dist-tags.mjs --phase before-publish|after-publish --version <version> " +
  "--dist-tag <tag> [--publish-needed true|false] [--before-file <path>]";

function usage(message) {
  console.error(`ERROR: ${message}\n${USAGE}`);
  process.exit(2);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const phase = option("--phase");
  const version = option("--version");
  const distTag = option("--dist-tag");
  const publishNeededRaw = option("--publish-needed");
  const beforeFile = option("--before-file");

  if (!phase || !SDK_DIST_TAG_PHASES.includes(phase)) {
    usage(`--phase must be one of ${SDK_DIST_TAG_PHASES.join(", ")}, got ${String(phase)}`);
  }
  if (!version || !distTag) usage("--version and --dist-tag are required");

  let publishNeeded;
  if (phase === "before-publish") {
    // Only `"true"` and `"false"`. `PUBLISH_NEEDED` reaches this through `GITHUB_ENV`, and treating
    // an empty or misspelled value as falsy would silently run the rerun branch on a first publish.
    if (publishNeededRaw !== "true" && publishNeededRaw !== "false") {
      usage(`--publish-needed must be true or false, got ${String(publishNeededRaw)}`);
    }
    publishNeeded = publishNeededRaw === "true";
    if (beforeFile !== undefined) usage("--before-file applies only to --phase after-publish");
  } else {
    if (publishNeededRaw !== undefined) {
      usage("--publish-needed applies only to --phase before-publish");
    }
    // Required, not optional: without it the only thing proven is that no tag happens to equal this
    // version, which passes while another channel moves somewhere else entirely.
    if (!beforeFile) {
      usage(
        "--before-file is required after publishing. Verifying the current values alone cannot " +
          `express "this release moved one channel and nothing else"; see ${SDK_RUNBOOK}.`,
      );
    }
  }

  let distTags;
  try {
    distTags = readDistTags(SDK_PACKAGE_NAME);
  } catch (error) {
    // A failed read is not a passing check. Before the publish that means refusing to publish;
    // after it, the write already happened and this run must still go red.
    console.error(`ERROR: could not read ${SDK_PACKAGE_NAME} dist-tags: ${error.message}`);
    process.exit(1);
  }

  const failures =
    phase === "before-publish"
      ? auditSdkDistTagsBeforePublish({ distTags, version, distTag, publishNeeded })
      : auditSdkDistTagsAfterPublish({ distTags, version, distTag });

  if (phase === "after-publish") {
    const snapshot = readDistTagSnapshot(/** @type {string} */ (beforeFile));
    if ("error" in snapshot) {
      console.error(`ERROR: ${snapshot.error}`);
      process.exit(1);
    }
    failures.push(
      ...auditUnchangedDistTags({ before: snapshot.distTags, after: distTags, channel: distTag }),
    );
  }

  if (failures.length > 0) {
    console.error(
      `\n✖ ${SDK_PACKAGE_NAME} dist-tags do not match the channel policy (${phase}):\n`,
    );
    for (const failure of failures) console.error(`  - ${failure}`);
    if (phase === "before-publish") {
      console.error(`\nRefusing to publish ${version}. Nothing has been written to npm.`);
    } else {
      console.error(
        `\nNothing was changed. Moving a dist-tag is a publication decision; see ${SDK_RUNBOOK}.`,
      );
    }
    process.exit(1);
  }

  console.log(`✓ ${SDK_PACKAGE_NAME} dist-tags match the channel policy (${phase})`);
  for (const [tag, tagged] of Object.entries(distTags).sort()) {
    console.log(`  ${tag}: ${tagged}`);
  }
}
