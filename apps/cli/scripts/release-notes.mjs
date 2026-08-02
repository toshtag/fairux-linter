#!/usr/bin/env node
/**
 * Generate the CLI's GitHub Release body from facts, rather than from prose kept in sync by hand.
 *
 * Two properties are load-bearing, and they pull in opposite directions.
 *
 * **The notes are user-facing prose.** They are the first thing a prospective user reads, so they
 * have to say what `fairux` is, how to install this channel, and what it does not do yet.
 *
 * **The notes are published by the privileged job.** That job holds `id-token: write` and
 * `contents: write`, installs nothing, and runs Node built-ins only. So every *release-variable*
 * fact — package name, version, description, Node engines, repository URL, tag, source commit, npm
 * dist-tag, tarball filename, checksum filename — comes from one of exactly two places: the trusted
 * checkout's own `apps/cli/package.json`, or a value the release-bundle verifier derived in that
 * job and wrote to `GITHUB_ENV`. This module makes no npm or GitHub query to fill a gap; what it
 * cannot source, it refuses.
 *
 * The explanatory copy around those facts is version-controlled text living in this file, pinned by
 * semantic tests rather than by a snapshot of every sentence.
 *
 * Not a rename of `packages/sdk/scripts/release-notes.mjs`. The SDK's notes are organised around
 * three importable entry points and a RulePack API; `fairux` has one binary and a scan command,
 * and the two packages' beta caveats are different lists. What the CLI's borrows is the shape:
 * a pure generator, a main guard, fail-closed validation, and an invocation the workflow contract
 * can compare exactly rather than grep for.
 *
 * The `sdk-v0.1.0-beta.2` Release doubled the `v` its version already carried and advertised an
 * exact version rather than the channel the release is announced on (issue #63). Both are refused
 * here.
 */
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import { pathToFileURL } from "node:url";
import { classifyVersion } from "../../../scripts/release-version-contract.mjs";
import {
  CLI_PACKAGE_NAME,
  CLI_RELEASE_CHECKSUM_FILE,
  CLI_REPOSITORY_HTTPS_URL,
  CLI_STABLE_DIST_TAG,
  cliReleaseTag,
  cliTarballName,
  resolveCliRelease,
} from "./cli-release-contract.mjs";

/**
 * The repository these notes may link into.
 *
 * A manifest URL that merely has the *shape* `https://github.com/<o>/<r>` is not enough:
 * `https://github.com/attacker/repository` normalizes just as cleanly, and every documentation
 * link in the body would follow it. The destination is pinned, not merely well-formed.
 *
 * Re-exported from the release contract rather than spelled again. Two spellings were the defect:
 * this module refused a wrong repository and the manifest audit did not check the field at all,
 * so a drifted manifest passed every pre-publish gate and failed here — after `npm publish`.
 */
export const CLI_REPOSITORY_URL = CLI_REPOSITORY_HTTPS_URL;

/** The `##` headings of the generated body, in order. Each appears exactly once. */
export const CLI_RELEASE_SECTIONS = Object.freeze([
  "Overview",
  "Install",
  "Usage",
  "Compatibility",
  "Trust and verification",
  "Assets",
  "Caveats",
  "Documentation",
]);

/** Documentation the notes link, as repository-relative paths. */
const DOCUMENTATION_LINKS = Object.freeze([
  ["CLI README", "apps/cli/README.md"],
  ["GitHub Actions and SARIF guide", "docs/github-actions.md"],
  ["Rule catalog", "docs/generated/rule-catalog.md"],
  ["FairUX report schema", "docs/fairux-report-schema.md"],
  ["Project roadmap", "docs/roadmap.md"],
  ["CLI beta release runbook", "docs/cli-beta-release.md"],
]);

export class CliReleaseNotesError extends Error {
  constructor(message) {
    super(message);
    this.name = "CliReleaseNotesError";
  }
}

const COMMIT_SHA = /^[0-9a-f]{40}$/;
const REPOSITORY_HTTPS_URL = /^https:\/\/github\.com\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

/**
 * C0 and C1 controls, newline included.
 *
 * The newline is the interesting one: every external value below is interpolated into a line of
 * Markdown, so a single embedded newline is enough to open a heading, a list, or a fence.
 */
function hasControlCharacter(value) {
  for (const character of value) {
    const code = /** @type {number} */ (character.codePointAt(0));
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return false;
}

function requireInertString(label, value) {
  if (typeof value !== "string") {
    throw new CliReleaseNotesError(`${label} must be a string, got ${typeof value}`);
  }
  if (value === "") throw new CliReleaseNotesError(`${label} must not be empty`);
  if (hasControlCharacter(value)) {
    throw new CliReleaseNotesError(`${label} contains a newline or control character`);
  }
  return value;
}

function requireExactly(label, actual, expected) {
  requireInertString(label, actual);
  if (actual !== expected) {
    throw new CliReleaseNotesError(`${label} must be ${expected}, got ${actual}`);
  }
  return actual;
}

/**
 * Normalize a manifest `repository` field to the plain HTTPS URL a reader can follow.
 *
 * `git+https://github.com/toshtag/fairux-linter.git` → `https://github.com/toshtag/fairux-linter`.
 * Anything that does not reduce to exactly `https://github.com/<owner>/<repo>` is refused rather
 * than pasted into a link.
 */
export function repositoryHttpsUrl(repository) {
  const raw = typeof repository === "string" ? repository : repository?.url;
  requireInertString("repository url", raw);
  const normalized = raw
    .replace(/^git\+/, "")
    .replace(/\.git$/, "")
    .replace(/\/+$/, "");
  if (!REPOSITORY_HTTPS_URL.test(normalized)) {
    throw new CliReleaseNotesError(
      `repository url does not normalize to https://github.com/<owner>/<repo>: ${raw}`,
    );
  }
  return normalized;
}

/**
 * Assemble the generator's input from the trusted checkout's manifest plus the values the publish
 * job verified for itself.
 */
export function cliReleaseNotesInput({
  manifest,
  tag,
  sourceCommit,
  npmDistTag,
  tarballFilename,
  checksumFilename,
}) {
  if (typeof manifest !== "object" || manifest === null) {
    throw new CliReleaseNotesError("manifest must be an object");
  }
  return {
    packageName: manifest.name,
    version: manifest.version,
    description: manifest.description,
    nodeEngines: manifest.engines?.node,
    repositoryUrl: repositoryHttpsUrl(manifest.repository),
    tag,
    sourceCommit,
    npmDistTag,
    tarballFilename,
    checksumFilename,
  };
}

/**
 * The GitHub Release title.
 *
 * `fairux 0.1.0-beta.1`, not `fairux v0.1.0-beta.1`: the version already carries its own prefix
 * conventions, and the duplicated `v` shipped on `sdk-v0.1.0-beta.2`.
 */
export function cliReleaseTitle({ packageName, version }) {
  const name = requireExactly("package name", packageName, CLI_PACKAGE_NAME);
  return `${name} ${requireInertString("version", version)}`;
}

function validateInput(input) {
  requireExactly("package name", input.packageName, CLI_PACKAGE_NAME);
  const version = requireInertString("version", input.version);

  if (!classifyVersion(version).valid) {
    throw new CliReleaseNotesError(`version is not valid SemVer: ${version}`);
  }

  // The same resolver the workflow's first gate uses, so the notes cannot describe a release the
  // workflow would have refused — the bootstrap placeholder above all.
  let release;
  try {
    release = resolveCliRelease(cliReleaseTag(version));
  } catch (error) {
    throw new CliReleaseNotesError(error.message);
  }

  requireExactly("tag", input.tag, release.tag);
  // Derived, not accepted: notes that advertise a channel the release did not publish to would
  // hand a reader an install command nobody can use.
  requireExactly("npm dist-tag", input.npmDistTag, release.distTag);
  requireExactly("tarball filename", input.tarballFilename, cliTarballName(version));
  requireExactly("checksum filename", input.checksumFilename, CLI_RELEASE_CHECKSUM_FILE);

  const sourceCommit = requireInertString("source commit", input.sourceCommit);
  if (!COMMIT_SHA.test(sourceCommit)) {
    throw new CliReleaseNotesError(`source commit is not a full 40-hex SHA: ${sourceCommit}`);
  }

  requireInertString("description", input.description);
  requireInertString("node engines", input.nodeEngines);
  requireExactly("repository url", input.repositoryUrl, repositoryHttpsUrl(input.repositoryUrl));
  requireExactly("repository url", input.repositoryUrl, CLI_REPOSITORY_URL);

  return release;
}

/**
 * Render the GitHub Release body for one CLI release.
 *
 * Deterministic: same input, same bytes. No filesystem, process, or network access, and no clock —
 * the notes carry no timestamp, so regenerating them for an existing Release produces the body that
 * Release already has, which is what makes the create-or-edit path idempotent.
 *
 * @param {import("./release-notes.d.mts").CliReleaseNotesInput} input
 * @returns {string} Markdown ending in exactly one newline.
 */
export function generateCliReleaseNotes(input) {
  const release = validateInput(input);
  const {
    packageName,
    version,
    description,
    nodeEngines,
    repositoryUrl,
    tag,
    sourceCommit,
    npmDistTag,
    tarballFilename,
    checksumFilename,
  } = input;

  // A prerelease is installed by naming its channel. A stable release is what a bare
  // `npm install --global fairux` resolves, so naming the tag there would be noise.
  const installSpec =
    npmDistTag === CLI_STABLE_DIST_TAG ? packageName : `${packageName}@${npmDistTag}`;

  const paragraphs = [
    ["Overview", `\`${packageName}\` — ${description}`],
    [
      "Overview",
      "FairUX reports UX risk signals with evidence, severity, confidence, rule identity, an " +
        "explanation of why the issue matters, and a human-readable recommendation. It does not " +
        "return a fraud, legal, or safety verdict, and no finding count proves that an interface " +
        "is fair. Zero findings is not a passing grade.",
    ],
    ["Install", ["```bash", `npm install --global ${installSpec}`, "```"].join("\n")],
    ...(release.prerelease
      ? [
          [
            "Install",
            // What this release *did*, not what the registry currently holds. The notes used to
            // say `latest` was not set — true of the first beta, and false as soon as a stable
            // release exists, which the channel policy now allows. The generator is not told what
            // `latest` points at, and a claim about it would be one it cannot source.
            `This prerelease is published on the \`${npmDistTag}\` dist-tag. This release does not ` +
              `move \`${CLI_STABLE_DIST_TAG}\`, so installing it stays explicit.`,
          ],
        ]
      : []),
    [
      "Usage",
      [
        "```bash",
        "fairux scan ./dist/index.html",
        "fairux scan 'src/**/*.{html,jsx,tsx}' --format json",
        "cat page.html | fairux scan - --format sarif",
        "```",
      ].join("\n"),
    ],
    [
      "Usage",
      "Scan a file, a directory, a glob, or stdin (`-`). Output is Markdown by default, or " +
        "`--format json` / `--format sarif`. `--fail-on <severity>` is what makes a scan fail a " +
        "build; without it the CLI exits 0 when it finds something, because findings are signals " +
        "rather than errors. `fairux.config.json` is discovered automatically; an executable " +
        "`fairux.config.ts` is only loaded when you pass `--config` explicitly, and " +
        "`--ignore-config` skips discovery entirely.",
    ],
    [
      "Compatibility",
      [
        `- Node.js \`${nodeEngines}\`.`,
        "- Scans HTML, JSX, and TSX. Local-only: the engine and the built-in rule pack make no " +
          "network or AI call.",
        "- SARIF 2.1.0 output for GitHub code scanning; see the GitHub Actions guide below.",
      ].join("\n"),
    ],
    [
      "Trust and verification",
      [
        // Two claims, kept apart because they have different evidence and different scopes.
        //
        // The first is about this repository's configuration, which the notes can state because
        // it is checked out beside them. It is deliberately not "published with Trusted
        // Publishing": on a rerun of a release that already landed, this run publishes nothing,
        // and the notes are regenerated identically — a past-tense claim would be false in exactly
        // the case the rerun path exists for.
        //
        // The second is about what the registry answered, which the workflow read back. Metadata
        // saying an attestation exists does not by itself establish which workflow produced it,
        // from which commit, or that it covers the tarball this run audited.
        "- The release workflow is configured to publish through npm Trusted Publishing over " +
          "OIDC. It supplies no long-lived npm token, and before every npm call it verifies that " +
          "no npm credential is present in the job environment or in the project, user, or " +
          "global npm config — refusing to continue if one is.",
        "- The npm registry reports provenance attestation metadata for this version. Full " +
          "signature, attestation, and source-identity verification of a *downloaded* package is " +
          "`npm audit signatures` against a clean registry install, which is not run here.",
        `- Built from tag \`${tag}\`, commit \`${sourceCommit}\`.`,
        "- The tarball is packed once, by an unprivileged job, and its contents are re-audited " +
          "from the tagged checkout before the privileged job publishes those exact bytes.",
        "- After the publish, the registry's `dist.shasum` and `dist.integrity` are compared " +
          `against the audited tarball, and the dist-tags are read back: \`npm view ${packageName}@${version} dist.integrity\`.`,
        `- \`${checksumFilename}\` on this Release is a SHA-256 checksum for the tarball attached ` +
          "**here**. The two use different digest formats and cover downloads from different " +
          "distribution endpoints; neither is a substitute for the other.",
      ].join("\n"),
    ],
    [
      "Assets",
      [
        "| Asset | What it is |",
        "| --- | --- |",
        `| \`${tarballFilename}\` | The \`${packageName}\` package tarball attached to this Release |`,
        `| \`${checksumFilename}\` | \`<sha256>  <filename>\` for that attached tarball |`,
      ].join("\n"),
    ],
    [
      "Caveats",
      [
        ...(release.prerelease
          ? [
              "- The command-line interface, the report schema, and the rule set are beta and may " +
                "change before a stable release.",
              `- Version \`${version}\` is published on \`${npmDistTag}\`; this release does not ` +
                `set \`${CLI_STABLE_DIST_TAG}\`.`,
            ]
          : []),
        "- No coverage-aware risk index and no scoring.",
        "- No baselines, no suppressions, and no `.fairuxignore`.",
        "- No machine-applicable remediation and no `--write`; findings still include " +
          "human-readable recommendations.",
        "- No AI review.",
        "- External RulePacks cannot yet be loaded from the CLI.",
        "- Rules run against HTML, JSX, and TSX source. Behaviour that only appears at runtime — " +
          "timing, navigation, network — is out of scope for this release.",
      ].join("\n"),
    ],
    [
      "Documentation",
      DOCUMENTATION_LINKS.map(
        ([label, path]) => `- [${label}](${repositoryUrl}/blob/main/${path})`,
      ).join("\n"),
    ],
    [
      "Documentation",
      "These links follow `main`, so a later correction reaches a reader of this Release. The " +
        "immutable source it was built from is the tag and commit above.",
    ],
  ];

  const lines = [];
  let openSection = null;
  for (const [section, body] of paragraphs) {
    if (section === openSection) {
      lines.push("");
    } else {
      if (openSection !== null) lines.push("");
      lines.push(`## ${section}`, "");
      openSection = section;
    }
    lines.push(body);
  }
  return `${lines.join("\n")}\n`;
}

/** Where this script sits, as a caller must spell it to `node` from the repository root. */
export const CLI_RELEASE_NOTES_SCRIPT = "apps/cli/scripts/release-notes.mjs";

/** The manifest a caller reads the release-variable facts from. */
export const CLI_MANIFEST_PATH = "apps/cli/package.json";

/**
 * The whole `node` argv for one release's notes, derived from the three values that vary.
 *
 * A caller assembling this list itself is how the SDK's release dry run stopped rehearsing its
 * publish job: the script's signature changed under it and the dry run kept passing the old flag.
 * Deriving it here makes an invocation a value a test can compare exactly, rather than option names
 * a test can only find somewhere in a file.
 */
export function cliReleaseNotesInvocation({ tag, sourceCommit, tarball, out }) {
  const args = [
    CLI_RELEASE_NOTES_SCRIPT,
    "--package-json",
    CLI_MANIFEST_PATH,
    "--tag",
    tag,
    "--source-commit",
    sourceCommit,
    "--dist-tag",
    // From the same resolver the workflow's first gate uses, so the notes cannot name a channel
    // the release does not publish to. A tag this workflow refuses has no invocation at all.
    resolveCliRelease(tag).distTag,
    "--tarball",
    tarball,
    "--checksum",
    CLI_RELEASE_CHECKSUM_FILE,
  ];
  if (out !== undefined) args.push("--out", out);
  return args;
}

const REQUIRED_OPTIONS = Object.freeze([
  "--package-json",
  "--tag",
  "--source-commit",
  "--dist-tag",
  "--tarball",
  "--checksum",
]);

const USAGE = [
  "Usage: release-notes.mjs \\",
  "  --package-json <path> --tag <tag> --source-commit <sha> \\",
  "  --dist-tag <tag> --tarball <path> --checksum <path> [--out <file>]",
].join("\n");

/** A malformed invocation, kept apart from input the generator refuses: exit 2 rather than 1. */
class UsageError extends Error {}

function parseOptions(argv) {
  const options = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (!REQUIRED_OPTIONS.includes(flag) && flag !== "--out") {
      throw new UsageError(`unknown argument: ${flag}`);
    }
    if (options.has(flag)) throw new UsageError(`repeated argument: ${flag}`);
    const value = argv[index + 1];
    if (value === undefined) throw new UsageError(`${flag} requires a value`);
    options.set(flag, value);
    index += 1;
  }
  for (const flag of REQUIRED_OPTIONS) {
    if (!options.has(flag)) throw new UsageError(`${flag} is required`);
  }
  return options;
}

function main(argv) {
  const options = parseOptions(argv);
  const manifest = JSON.parse(readFileSync(options.get("--package-json"), "utf8"));
  const notes = generateCliReleaseNotes(
    cliReleaseNotesInput({
      manifest,
      tag: options.get("--tag"),
      sourceCommit: options.get("--source-commit"),
      npmDistTag: options.get("--dist-tag"),
      // The workflow passes the verified paths it already holds; the notes name files.
      tarballFilename: basename(options.get("--tarball")),
      checksumFilename: basename(options.get("--checksum")),
    }),
  );
  const out = options.get("--out");
  if (out) writeFileSync(out, notes, "utf8");
  else process.stdout.write(notes);
}

/**
 * True only when this file is the process entry point.
 *
 * Compared as file URLs rather than as paths, so a Windows drive letter or a separator difference
 * cannot decide it, and `realpathSync` resolves a symlinked entry point.
 */
function isEntryPoint() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(entry)).href;
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    if (error instanceof UsageError) {
      console.error(`ERROR: ${error.message}\n${USAGE}`);
      process.exit(2);
    }
    console.error(`ERROR: ${error.message}`);
    process.exit(1);
  }
}
