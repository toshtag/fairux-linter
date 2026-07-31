#!/usr/bin/env node
/**
 * Decide whether a GitHub Release for this tag already exists, and whether it may be repaired.
 *
 * Writes `RELEASE_EXISTS=true|false` to `GITHUB_ENV` so the workflow can branch between create and
 * repair, and exits non-zero when an existing Release is not classified the way this release
 * requires.
 *
 * The interesting part is the branch, not the check. `gh release view` failing is not the same as
 * the Release not existing: a token problem, an API outage, or a rate limit all fail too, and
 * treating any of them as "not there" would send the run down the *create* path — where
 * `gh release create` would try to make a Release that may already exist, or succeed and produce a
 * second one. So the exit status is read against GitHub's own 404, through `gh api` rather than by
 * matching text on stderr: `gh api` reports the HTTP status, and a message string is not a status.
 *
 * Node built-ins and `gh` only.
 */
import { appendFileSync } from "node:fs";
import { runSync } from "../../../scripts/release-subprocess.mjs";
import {
  auditExistingCliRelease,
  CLI_RELEASE_VIEW_FIELDS,
} from "./cli-github-release-contract.mjs";

/**
 * The REST API version this contract was written against.
 *
 * GitHub versions its API by date and warns before breaking changes; a request that names no
 * version gets whatever is current, so a future change would arrive as a release-time surprise
 * rather than as a decision.
 */
const GITHUB_API_VERSION = "2026-03-10";

const USAGE =
  "Usage: verify-existing-cli-release.mjs --tag <tag> --prerelease true|false " +
  "[--repository <owner/repo>] [--github-env <path>]";

function option(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function usage(message) {
  console.error(`ERROR: ${message}\n${USAGE}`);
  process.exit(2);
}

const tag = option("--tag");
const prereleaseRaw = option("--prerelease");
const repository = option("--repository") ?? process.env.GITHUB_REPOSITORY;
const githubEnv = option("--github-env") ?? process.env.GITHUB_ENV;

if (!tag) usage("--tag is required");
if (prereleaseRaw !== "true" && prereleaseRaw !== "false") {
  // Strict, for the same reason `--publish-needed` is: this arrives through `GITHUB_ENV` as text,
  // and a misspelled value read as falsy would expect a stable Release for a beta.
  usage(`--prerelease must be true or false, got ${String(prereleaseRaw)}`);
}
if (!repository) usage("--repository or GITHUB_REPOSITORY is required");

const expectedPrerelease = prereleaseRaw === "true";

/**
 * Ask GitHub for the release by tag, and separate "there is none" from "the question failed".
 *
 * `gh api --include` prints the response headers, so the status line is readable whatever the body
 * says. Only a 404 means absent; every other failure is raised.
 *
 * @returns {{ release: unknown } | { absent: true }}
 */
function readExistingRelease() {
  let stdout;
  try {
    stdout = runSync("gh", [
      "api",
      "--include",
      "--header",
      "Accept: application/vnd.github+json",
      "--header",
      `X-GitHub-Api-Version: ${GITHUB_API_VERSION}`,
      // Encoded, not interpolated: a tag may contain characters that mean something in a URL, and
      // git permits more of them than a path segment does.
      `repos/${repository}/releases/tags/${encodeURIComponent(tag)}`,
      "--jq",
      // The same three fields the contract reads, named here so the shapes cannot drift.
      `{${CLI_RELEASE_VIEW_FIELDS.map((field) => {
        const source = { tagName: "tag_name", isDraft: "draft", isPrerelease: "prerelease" }[field];
        return `${field}: .${source}`;
      }).join(", ")}}`,
    ]);
  } catch (error) {
    const combined = `${String(error.stdout ?? "")}\n${String(error.stderr ?? "")}`;
    // The status line, not the message. `gh` says "Not Found" for a missing repository and for a
    // missing release, and a token without `contents: read` says something else again.
    if (/^HTTP\/[\d.]+ 404\b/m.test(combined)) return { absent: true };
    throw error;
  }

  // `--include` puts headers first; the body is whatever follows the blank line.
  const separator = stdout.search(/\r?\n\r?\n/);
  const body = separator === -1 ? stdout : stdout.slice(separator).trim();
  if (body === "") throw new Error("gh api returned no body for an existing release");
  return { release: JSON.parse(body) };
}

let result;
try {
  result = readExistingRelease();
} catch (error) {
  console.error(
    `ERROR: could not determine whether a GitHub Release exists for ${tag}: ${error.message}`,
  );
  process.exit(1);
}

if ("absent" in result) {
  console.log(`✓ no GitHub Release exists for ${tag}; one will be created`);
  if (githubEnv) appendFileSync(githubEnv, "RELEASE_EXISTS=false\n", "utf8");
  process.exit(0);
}

const failures = auditExistingCliRelease({
  expectedTag: tag,
  expectedPrerelease,
  release: result.release,
});

if (failures.length > 0) {
  console.error(`\n✖ the existing GitHub Release for ${tag} cannot be repaired in place:\n`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

console.log(
  `✓ the existing GitHub Release for ${tag} is classified as a ` +
    `${expectedPrerelease ? "prerelease" : "stable release"}; its notes and assets will be repaired`,
);
if (githubEnv) appendFileSync(githubEnv, "RELEASE_EXISTS=true\n", "utf8");
