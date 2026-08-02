/**
 * What a `fairux` CLI release is, as one module a test can run.
 *
 * The publish workflow used to answer these questions inline in `validate`: a shell comparison of
 * the tag against the manifest version, a `git merge-base` check, and a `node -e` call into the
 * shared SemVer contract. That catches a mistyped tag. It never asserted the two facts a release of
 * *this* package rests on — that the checkout builds `fairux`, and that `fairux` is publishable —
 * so both were first checked by the packed-tarball audit, after an install and a pack had already
 * run. `publish-sdk.yml` asserts its package name and `private` in `validate`, before any
 * dependency is installed; this is the CLI's half of the same boundary.
 *
 * The bootstrap rule is why this is a module rather than three more shell lines. `fairux` does not
 * exist on npm, and an npm Trusted Publisher record is configured on a package's own settings page,
 * so the name must be created by a one-off manual publish before OIDC publishing can be configured
 * for it (`docs/maintainers/release-cli.md`). That placeholder is a permanent version on the registry, and
 * it is a prerelease — so the repository-wide "prerelease is next" policy would route it to the
 * beta channel. A release workflow that accepted it would publish a placeholder over `next`.
 *
 * Pure: no filesystem, no process, no network. The entrypoints beside this file supply those.
 */
import { packedTarballName } from "../../../scripts/release-bundle-contract.mjs";
import {
  classifyVersion,
  distTagFor,
  isBootstrapPrerelease,
} from "../../../scripts/release-version-contract.mjs";

/** The only package this contract describes. A release of anything else is a bug, not a variant. */
export const CLI_PACKAGE_NAME = "fairux";

/** `v0.1.0-beta.1`. The SDK uses `sdk-v`; the two workflows must never match each other's tags. */
export const CLI_TAG_PREFIX = "v";

/** The placeholder that reserves the name on npm. Never published by this workflow. */
export const CLI_BOOTSTRAP_VERSION = "0.0.0-bootstrap.0";

/** Where the placeholder lives, so it is reachable by name and on no channel a user installs. */
export const CLI_BOOTSTRAP_DIST_TAG = "bootstrap";

/** The beta channel. Opting in stays explicit: `npm install --global fairux@next`. */
export const CLI_PRERELEASE_DIST_TAG = "next";

/** Reserved for the first stable release. Until then it must not exist at all. */
export const CLI_STABLE_DIST_TAG = "latest";

/** The checksum file `scripts/assemble-release-bundle.mjs` writes into every bundle. */
export const CLI_RELEASE_CHECKSUM_FILE = "release-sha256.txt";

/** `files`, exactly. A widened allowlist is how a package starts shipping things nobody reviewed. */
export const CLI_PUBLISHED_FILES = Object.freeze(["dist", "README.md", "LICENSE", "NOTICE"]);

export const CLI_LICENSE = "Apache-2.0";

/**
 * The repository this package belongs to, in the two spellings a manifest and a reader each need.
 *
 * One source, because two were the defect. `release-notes.mjs` knew the normalized HTTPS form and
 * refused anything else; the manifest audit checked only `repository.directory`. So a manifest
 * pointing at another repository passed every pre-publish gate and failed in the notes generator —
 * which, before this commit, ran *after* `npm publish`. The version would have been spent on a
 * package whose metadata sent every documentation link somewhere else.
 */
export const CLI_REPOSITORY_HTTPS_URL = "https://github.com/toshtag/fairux-linter";
export const CLI_REPOSITORY_GIT_URL = `git+${CLI_REPOSITORY_HTTPS_URL}.git`;
export const CLI_HOMEPAGE_URL = `${CLI_REPOSITORY_HTTPS_URL}#readme`;
export const CLI_BUGS_URL = `${CLI_REPOSITORY_HTTPS_URL}/issues`;

/**
 * The exact supported Node.js range, pinned rather than merely required to be non-empty.
 *
 * `engines.node: "*"` satisfied "declares a support range" and claims the CLI runs anywhere — on
 * Node 18, where the build toolchain does not. Widening the range is a support-policy change, so
 * it belongs in a pull request that moves this constant and the manifest together and says why.
 */
export const CLI_NODE_ENGINES = "^22.18.0 || >=24.11.0";

/**
 * The exact `prepublishOnly` command.
 *
 * Checking only that *some* string was present let the guard be replaced with anything —
 * `echo ok`, `node other-script.mjs`, or the original with `|| true` appended, which is the same
 * script with its exit status thrown away.
 */
export const CLI_PREPUBLISH_GUARD = "node scripts/prepublish-guard.mjs";
export const CLI_REPOSITORY_DIRECTORY = "apps/cli";
export const CLI_BIN_NAME = "fairux";
export const CLI_BIN_PATH = "./dist/index.js";

/**
 * Dependency maps a *source* manifest must not carry a `workspace:` specifier in.
 *
 * `devDependencies` is deliberately absent: `apps/cli/package.json` legitimately declares its
 * workspace siblings there, and pnpm strips dev dependencies when it packs. The packed manifest is
 * held to the stricter rule — no `workspace:` in any map — by `packed-tarball-contract.mjs`, which
 * is the one that inspects what actually ships.
 */
const PUBLISHED_DEPENDENCY_MAPS = Object.freeze([
  "dependencies",
  "optionalDependencies",
  "peerDependencies",
]);

/** Every map whose *shape* is checked, including the one whose ranges may be workspace links. */
const DEPENDENCY_MAPS = Object.freeze([...PUBLISHED_DEPENDENCY_MAPS, "devDependencies"]);

/**
 * The manifest comes from `JSON.parse`, so "object" here means what JSON can produce: not null,
 * not an array. Nothing else needs a prototype check.
 */
function isJsonObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export class CliReleaseError extends Error {
  constructor(message) {
    super(message);
    this.name = "CliReleaseError";
  }
}

/** The tag that releases a given version. Derived, so a caller cannot spell it a second way. */
export function cliReleaseTag(version) {
  return `${CLI_TAG_PREFIX}${version}`;
}

/**
 * Resolve a git tag into the release it names, or refuse it.
 *
 * `on.push.tags: ["v*"]` is wider than this contract: it also matches `vscode-extension-v1` and
 * `v2-spike`. Those fail here, at the first gate, with a message that says which rule they broke —
 * rather than further down as a version mismatch against a manifest they were never about.
 *
 * @param {string} tag
 * @returns {{tag: string, version: string, prerelease: boolean, distTag: string}}
 */
export function resolveCliRelease(tag) {
  if (typeof tag !== "string" || tag === "") {
    throw new CliReleaseError("release tag is missing");
  }
  if (!tag.startsWith(CLI_TAG_PREFIX)) {
    throw new CliReleaseError(`release tag must start with "${CLI_TAG_PREFIX}", got ${tag}`);
  }

  const version = tag.slice(CLI_TAG_PREFIX.length);
  const { valid, prerelease } = classifyVersion(version);
  if (!valid) {
    throw new CliReleaseError(`release tag does not carry a valid SemVer version: ${tag}`);
  }

  // Before the dist-tag is derived, not after. `distTagFor` would map the placeholder to `next`,
  // and a check that ran afterwards would be comparing a channel this version may never reach.
  if (isBootstrapPrerelease(version)) {
    throw new CliReleaseError(
      `${version} is a bootstrap placeholder and is published by hand, once, under the ` +
        `"${CLI_BOOTSTRAP_DIST_TAG}" dist-tag — never by this workflow. ` +
        "See docs/maintainers/release-cli.md.",
    );
  }

  const distTag = distTagFor(version);
  if (distTag === null) {
    throw new CliReleaseError(`no dist-tag policy applies to ${version}`);
  }

  return { tag, version, prerelease, distTag };
}

/**
 * Audit the checked-out `apps/cli/package.json` against the release the tag names.
 *
 * Returns every failure rather than throwing on the first: a release is blocked by all of its
 * problems, and reporting them one run at a time turns one fix into several red runs.
 *
 * @param {object} input
 * @param {Record<string, unknown>} input.manifest  `apps/cli/package.json`, parsed
 * @param {string} [input.tag]  when given, the manifest version must be the one it names
 * @returns {string[]} failures; empty means the manifest satisfies the contract
 */
export function auditCliReleaseManifest({ manifest, tag }) {
  const failures = [];
  const bad = (message) => failures.push(message);

  if (typeof manifest !== "object" || manifest === null) {
    return ["apps/cli/package.json did not parse to an object"];
  }

  if (manifest.name !== CLI_PACKAGE_NAME) {
    bad(`name must be "${CLI_PACKAGE_NAME}", got ${JSON.stringify(manifest.name)}`);
  }
  // Absent or the boolean `false`, and nothing else. The comment here used to say a string was
  // not a claim this contract accepts — while the code tested `=== true`, so `"private": "false"`
  // passed. npm reads any truthy `private` as private, and a manifest whose publishability depends
  // on how a value coerces is not one this release path should reason about.
  if (manifest.private !== undefined && manifest.private !== false) {
    bad(`private must be absent or the boolean false, got ${JSON.stringify(manifest.private)}`);
  }

  const { valid } = classifyVersion(manifest.version);
  if (!valid) {
    bad(`version is not valid SemVer: ${JSON.stringify(manifest.version)}`);
  } else if (isBootstrapPrerelease(manifest.version)) {
    bad(`version ${manifest.version} is a bootstrap placeholder, not a release`);
  }

  if (tag !== undefined) {
    let release;
    try {
      release = resolveCliRelease(tag);
    } catch (error) {
      bad(error.message);
    }
    if (release && release.version !== manifest.version) {
      bad(`tag ${tag} does not match the manifest version ${manifest.version}`);
    }
  }

  if (manifest.type !== "module") {
    bad(`type must be "module", got ${JSON.stringify(manifest.type)}`);
  }
  if (manifest.license !== CLI_LICENSE) {
    bad(`license must be ${CLI_LICENSE}, got ${JSON.stringify(manifest.license)}`);
  }
  if (manifest.bin?.[CLI_BIN_NAME] !== CLI_BIN_PATH) {
    bad(`bin.${CLI_BIN_NAME} must be ${CLI_BIN_PATH}, got ${JSON.stringify(manifest.bin)}`);
  }
  // The object form, not npm's string shorthand. This manifest is the source the release notes,
  // the packed-manifest audit, and every documentation link derive from, so "which repository is
  // this?" is answered one way rather than in whichever spelling happens to be present.
  if (!isJsonObject(manifest.repository)) {
    bad(`repository must be an object, got ${JSON.stringify(manifest.repository)}`);
  } else {
    if (manifest.repository.type !== "git") {
      bad(`repository.type must be "git", got ${JSON.stringify(manifest.repository.type)}`);
    }
    if (manifest.repository.url !== CLI_REPOSITORY_GIT_URL) {
      bad(
        `repository.url must be ${JSON.stringify(CLI_REPOSITORY_GIT_URL)}, got ` +
          JSON.stringify(manifest.repository.url),
      );
    }
    if (manifest.repository.directory !== CLI_REPOSITORY_DIRECTORY) {
      bad(`repository.directory must be ${CLI_REPOSITORY_DIRECTORY}`);
    }
  }

  if (manifest.homepage !== CLI_HOMEPAGE_URL) {
    bad(
      `homepage must be ${JSON.stringify(CLI_HOMEPAGE_URL)}, got ${JSON.stringify(manifest.homepage)}`,
    );
  }
  if (!isJsonObject(manifest.bugs)) {
    bad(`bugs must be an object, got ${JSON.stringify(manifest.bugs)}`);
  } else if (manifest.bugs.url !== CLI_BUGS_URL) {
    bad(
      `bugs.url must be ${JSON.stringify(CLI_BUGS_URL)}, got ${JSON.stringify(manifest.bugs.url)}`,
    );
  }
  if (typeof manifest.description !== "string" || manifest.description.trim() === "") {
    bad("description must be a non-empty string; it is the package's npm listing");
  }
  if (manifest.engines?.node !== CLI_NODE_ENGINES) {
    bad(
      `engines.node must be exactly ${JSON.stringify(CLI_NODE_ENGINES)}, got ` +
        JSON.stringify(manifest.engines?.node),
    );
  }

  const files = manifest.files;
  if (!Array.isArray(files) || files.join("\n") !== CLI_PUBLISHED_FILES.join("\n")) {
    bad(`files must be exactly [${CLI_PUBLISHED_FILES.join(", ")}], got ${JSON.stringify(files)}`);
  }

  // The direct-publish guard. It is a speed bump, not a fail-closed gate — `--ignore-scripts`
  // skips it, and the release path itself passes that flag — but a speed bump that has been
  // replaced is not one. Asserting only that *some* string was there accepted `echo ok`, a
  // different script, and the guard with `|| true` appended.
  if (manifest.scripts?.prepublishOnly !== CLI_PREPUBLISH_GUARD) {
    bad(
      `scripts.prepublishOnly must be exactly ${JSON.stringify(CLI_PREPUBLISH_GUARD)}, got ` +
        JSON.stringify(manifest.scripts?.prepublishOnly),
    );
  }

  // Shape before contents. `Object.entries("not-an-object")` enumerates the string's characters,
  // and `Object.entries([])` is empty, so a `dependencies` field of either kind walked cleanly
  // through the workspace check below and reported nothing — a manifest npm would refuse, or
  // silently read as having no dependencies, passing a contract whose whole point is to be exact.
  for (const map of DEPENDENCY_MAPS) {
    const declared = manifest[map];
    if (declared === undefined) continue;

    if (!isJsonObject(declared)) {
      bad(`${map} must be an object of name → range, got ${JSON.stringify(declared)}`);
      continue;
    }

    for (const [name, range] of Object.entries(declared)) {
      if (typeof range !== "string" || range.trim() === "") {
        bad(`${map}.${name} must be a non-empty range string, got ${JSON.stringify(range)}`);
        continue;
      }
      // Workspace links are legitimate in `devDependencies`; pnpm strips those when it packs.
      if (PUBLISHED_DEPENDENCY_MAPS.includes(map) && range.startsWith("workspace:")) {
        bad(`${map}.${name} is a workspace specifier and would not resolve for a consumer`);
      }
    }
  }

  return failures;
}

/** The tarball `pnpm pack` writes for a release, derived from the same helper the bundle uses. */
export function cliTarballName(version) {
  return packedTarballName(CLI_PACKAGE_NAME, version);
}

/** `fairux@0.1.0-beta.1` — the exact registry specifier a release publishes and then verifies. */
export function cliReleaseSpec(version) {
  return `${CLI_PACKAGE_NAME}@${version}`;
}
