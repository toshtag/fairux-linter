/**
 * Where a release write is allowed to land, and what must be there afterwards.
 *
 * Two boundaries the publish workflows did not close, both of which fail silently rather than
 * loudly:
 *
 * - **`gh` resolves its target from the environment.** `GH_REPO` wins over the checkout's remote,
 *   and an inherited value — from a composite action, a reusable workflow, an organisation-level
 *   variable — would send `gh release create` at a different repository while every other check in
 *   the run passed. Nothing in the run would look wrong.
 * - **A Release was never read back.** The workflow uploaded assets and stopped. "The bytes were
 *   handed to GitHub" is strictly weaker than "these bytes are what GitHub serves", and the whole
 *   release path is built on not confusing those two — the registry half already reads back the
 *   published digest.
 *
 * Pure. The caller reads the environment and the Release; this decides what the reading means.
 */

/** The only repository these workflows may write a Release to. */
export const RELEASE_REPOSITORY = "toshtag/fairux-linter";

/** Environment variables `gh` consults when deciding which repository a command targets. */
const GH_TARGET_VARS = Object.freeze(["GH_REPO", "GH_HOST", "GH_ENTERPRISE_TOKEN"]);

/**
 * Refuse an environment that could redirect a release write.
 *
 * `GH_REPO` is checked by value rather than by absence: a workflow that sets it *to the right
 * repository* is fine, and refusing that would push someone toward unsetting it in a way that makes
 * the next inherited value invisible again. `GH_HOST` and an enterprise token are refused outright —
 * neither has a correct value here, and both point at a different GitHub.
 *
 * @param {NodeJS.ProcessEnv} env
 * @param {{expected?: string}} [options]
 * @returns {string[]} failures; empty means the environment cannot redirect the write
 */
export function auditReleaseTargetEnvironment(env, { expected = RELEASE_REPOSITORY } = {}) {
  const failures = [];

  const repo = env.GH_REPO;
  if (repo !== undefined && repo !== "" && repo !== expected) {
    failures.push(
      `GH_REPO is ${JSON.stringify(repo)}, which would send this release write to a different ` +
        `repository than ${expected}`,
    );
  }
  for (const name of GH_TARGET_VARS.slice(1)) {
    if (env[name] !== undefined && env[name] !== "") {
      failures.push(`${name} is set, which points release writes at a different GitHub host`);
    }
  }

  // The workflow's own idea of where it is running. If this disagrees with the intended target the
  // run is on a fork or a rename, and neither should publish a Release under this project's name.
  const running = env.GITHUB_REPOSITORY;
  if (running !== undefined && running !== "" && running !== expected) {
    failures.push(`GITHUB_REPOSITORY is ${JSON.stringify(running)}, expected ${expected}`);
  }

  return failures;
}

/**
 * Parse a `sha256  name` checksum file into a map.
 *
 * @param {string} contents
 * @returns {Map<string, string>} basename → lowercase sha256
 */
export function parseChecksumFile(contents) {
  const entries = new Map();
  for (const line of contents.split("\n")) {
    const match = /^([0-9a-fA-F]{64})\s+\*?(.+?)\s*$/.exec(line);
    if (match?.[1] && match[2]) entries.set(match[2], match[1].toLowerCase());
  }
  return entries;
}

/**
 * What the published Release must be, compared against the bundle this run audited.
 *
 * Assets are compared **by digest of the downloaded bytes**, not by a metadata field. GitHub's API
 * does expose a digest for a release asset, but a field the publisher never re-downloads is a claim
 * about an API response rather than about what a consumer will receive — and the consumer downloads
 * bytes. This is the same distinction the registry verification already makes.
 *
 * An asset the run did not upload is a failure, not a curiosity: a Release carrying an extra file
 * under this tag is either a leftover from an attempt that was supposed to be superseded, or
 * something nobody in this run put there.
 *
 * @param {object} input
 * @param {unknown} input.release  parsed `gh release view --json tagName,isDraft,assets`
 * @param {Map<string, string>} input.expectedAssets  basename → sha256 the run produced
 * @param {Map<string, string>} input.downloadedAssets  basename → sha256 of the re-downloaded file
 * @param {string} input.expectedTag
 * @returns {string[]} failures; empty means the published Release is the audited bundle
 */
export function auditPublishedRelease({ release, expectedAssets, downloadedAssets, expectedTag }) {
  if (typeof release !== "object" || release === null || Array.isArray(release)) {
    return ["gh release view did not return an object"];
  }
  const failures = [];
  const { tagName, isDraft, assets } = /** @type {Record<string, unknown>} */ (release);

  if (tagName !== expectedTag) {
    failures.push(
      `published Release is on tag ${JSON.stringify(tagName)}, expected ${expectedTag}`,
    );
  }
  // A draft is not published. Reaching this check with one means the write did not do what the run
  // reported, and the assets below would be attached to something nobody can download.
  if (isDraft !== false) {
    failures.push(`published Release is a draft (isDraft=${JSON.stringify(isDraft)})`);
  }

  if (!Array.isArray(assets)) {
    failures.push("published Release exposes no assets array");
    return failures;
  }

  const published = new Map();
  for (const asset of assets) {
    const name = /** @type {Record<string, unknown>} */ (asset)?.name;
    if (typeof name !== "string") {
      failures.push(`published Release has an asset with no name: ${JSON.stringify(asset)}`);
      continue;
    }
    if (published.has(name)) {
      failures.push(`published Release has two assets named ${name}`);
      continue;
    }
    published.set(name, asset);
  }

  for (const [name, expectedSha] of expectedAssets) {
    const asset = published.get(name);
    if (!asset) {
      failures.push(`published Release is missing the asset ${name}`);
      continue;
    }
    // `uploaded` is the only state a consumer can download; `starter` and `open` are mid-upload.
    const state = /** @type {Record<string, unknown>} */ (asset).state;
    if (state !== undefined && state !== "uploaded") {
      failures.push(`published asset ${name} is in state ${JSON.stringify(state)}, not uploaded`);
    }
    const downloaded = downloadedAssets.get(name);
    if (downloaded === undefined) {
      failures.push(`published asset ${name} could not be downloaded for verification`);
    } else if (downloaded !== expectedSha) {
      failures.push(
        `published asset ${name} has SHA-256 ${downloaded}, expected ${expectedSha} — the bytes ` +
          "GitHub serves are not the bytes this run audited",
      );
    }
  }

  for (const name of published.keys()) {
    if (!expectedAssets.has(name)) {
      failures.push(`published Release carries an asset this run did not upload: ${name}`);
    }
  }

  return failures;
}
