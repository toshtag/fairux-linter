#!/usr/bin/env node
/**
 * Generate the SDK's GitHub Release body from facts, rather than from prose kept in sync by hand.
 *
 * The `sdk-v0.1.0-beta.2` Release shipped a flat bullet list that told a reader to install *after
 * publication* — of a package that was already on npm — and pinned an exact version instead of the
 * beta channel the release is actually announced on. It named no entry points, no provenance, and
 * neither of the two files attached to it
 * ([issue #63](https://github.com/toshtag/fairux-linter/issues/63)).
 *
 * Two properties are load-bearing here, and they pull in opposite directions.
 *
 * **The notes are user-facing prose.** They are the first thing a prospective consumer reads, so
 * they have to say what the package is, how to install the beta, what is public, and what was
 * actually verified.
 *
 * **The notes are published by the privileged job.** That job holds `id-token: write` and
 * `contents: write`, installs nothing, and runs Node built-ins only. So every *release-variable*
 * fact — package name, version, description, Node engines, public entry points, repository URL,
 * tag, source commit, npm dist-tag, tarball filename, checksum filename — comes from one of
 * exactly two places: the trusted checkout's own `packages/sdk/package.json`, or a value the
 * release-bundle verifier derived in that job and wrote to `GITHUB_ENV`. This module makes no npm
 * or GitHub query to fill a gap; what it cannot source, it refuses.
 *
 * The explanatory copy around those facts — the product boundary, the highlights, the caveats, the
 * third-party RulePack guidance, the documentation labels — is version-controlled text living in
 * this file. It is not derived from anything; its load-bearing claims are pinned by semantic
 * tests, which is narrower than every sentence being pinned.
 *
 * Hence the split: `generateSdkReleaseNotes` is pure and touches no filesystem, process, or
 * network, and the CLI at the bottom — behind a main guard, so importing this module runs nothing —
 * reads the manifest, passes the verified values through, and writes the file.
 *
 * Validation is fail-closed rather than best-effort. A wrong dist-tag would advertise an install
 * command nobody can use; a wrong tarball name would describe an asset that is not attached; a
 * newline in an external value would forge a heading the section contract never accounted for.
 * Each of those is refused, not rendered.
 *
 * What this module does not do is verify anything. It states what the workflow verified, and it
 * keeps npm's `dist.integrity`, the GitHub Release checksum file, and third-party RulePack
 * execution as three separate claims, because conflating them is how the earlier notes overstated
 * the evidence.
 */
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import { pathToFileURL } from "node:url";
import { packedTarballName } from "../../../scripts/release-bundle-contract.mjs";
import {
  classifyVersion,
  distTagFor,
  isBetaPrerelease,
} from "../../../scripts/release-version-contract.mjs";

/** The only package these notes describe. A release of anything else is a bug, not a variant. */
export const SDK_PACKAGE_NAME = "@fairux/sdk";

/** The beta channel. `latest` is deliberately left where it is, so opting in stays explicit. */
export const SDK_BETA_DIST_TAG = "next";

/**
 * The checksum file `scripts/assemble-release-bundle.mjs` writes and
 * `scripts/release-bundle-contract.mjs` requires. Spelled again here because these notes describe
 * it to a reader; `release-notes.test.ts` pins the spellings together so they cannot drift apart.
 */
export const SDK_RELEASE_CHECKSUM_FILE = "release-sha256.txt";

/**
 * The three public code entry points of `@fairux/sdk`, in manifest order.
 * `./package.json` is a tooling export, not a code API.
 */
export const SDK_PUBLIC_ENTRY_POINTS = Object.freeze([
  "@fairux/sdk",
  "@fairux/sdk/html",
  "@fairux/sdk/dom",
]);

/** The `##` headings of the generated body, in order. Each appears exactly once. */
export const SDK_RELEASE_SECTIONS = Object.freeze([
  "Overview",
  "Install",
  "Highlights",
  "Public entry points",
  "Compatibility",
  "Trust and verification",
  "Assets",
  "Beta caveats",
  "Documentation",
]);

const ENTRY_POINT_PURPOSE = Object.freeze({
  "@fairux/sdk": "Core types, RulePack composition, and the root scanner facade",
  "@fairux/sdk/html": "HTML string scanning",
  "@fairux/sdk/dom": "Live DOM scanning",
});

/**
 * Documentation the notes link, as repository-relative paths.
 *
 * Linked at `main` rather than at the release tag on purpose: these are how-to documents, and a
 * later correction should reach someone reading an older Release. The immutable source this
 * release was built from is named in "Trust and verification", as a tag and a commit.
 */
const DOCUMENTATION_LINKS = Object.freeze([
  ["SDK README", "packages/sdk/README.md"],
  ["RulePack authoring guide", "docs/rule-pack-authoring.md"],
  ["RulePack testing guide", "docs/rule-pack-testing.md"],
  ["RulePack taxonomy migration guide", "docs/migrations/rule-pack-taxonomy-beta.1.md"],
  ["FairUX report schema", "docs/fairux-report-schema.md"],
  ["Project status", "docs/status.md"],
  ["SDK beta release runbook", "docs/sdk-beta-release.md"],
]);

export class SdkReleaseNotesError extends Error {
  constructor(message) {
    super(message);
    this.name = "SdkReleaseNotesError";
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
    throw new SdkReleaseNotesError(`${label} must be a string, got ${typeof value}`);
  }
  if (value === "") throw new SdkReleaseNotesError(`${label} must not be empty`);
  if (hasControlCharacter(value)) {
    throw new SdkReleaseNotesError(`${label} contains a newline or control character`);
  }
  return value;
}

function requireExactly(label, actual, expected) {
  requireInertString(label, actual);
  if (actual !== expected) {
    throw new SdkReleaseNotesError(`${label} must be ${expected}, got ${actual}`);
  }
  return actual;
}

/**
 * Normalize a manifest `repository` field to the plain HTTPS URL a reader can follow.
 *
 * `git+https://github.com/toshtag/fairux-linter.git` → `https://github.com/toshtag/fairux-linter`.
 * Anything that does not reduce to exactly `https://github.com/<owner>/<repo>` is refused rather
 * than pasted into a link: an SSH remote, a host that is not GitHub, or a URL carrying credentials
 * would each send every documentation link somewhere other than this repository.
 */
export function repositoryHttpsUrl(repository) {
  const raw = typeof repository === "string" ? repository : repository?.url;
  requireInertString("repository url", raw);
  const normalized = raw
    .replace(/^git\+/, "")
    .replace(/\.git$/, "")
    .replace(/\/+$/, "");
  if (!REPOSITORY_HTTPS_URL.test(normalized)) {
    throw new SdkReleaseNotesError(
      `repository url does not normalize to https://github.com/<owner>/<repo>: ${raw}`,
    );
  }
  return normalized;
}

/**
 * The public entry points a manifest declares, in manifest order.
 *
 * `./package.json` is exported for tooling that reads the manifest and is not an API, so it is not
 * an entry point here. The result is checked against `SDK_PUBLIC_ENTRY_POINTS` by the generator:
 * adding a subpath export without deciding whether it is public would otherwise announce it.
 */
export function sdkPublicEntryPoints(manifest) {
  const name = requireInertString("package name", manifest?.name);
  const exportMap = manifest?.exports;
  if (typeof exportMap !== "object" || exportMap === null || Array.isArray(exportMap)) {
    throw new SdkReleaseNotesError("manifest exports must be an object");
  }
  return Object.keys(exportMap)
    .filter((subpath) => subpath !== "./package.json")
    .map((subpath) => {
      if (subpath === ".") return name;
      if (!subpath.startsWith("./")) {
        throw new SdkReleaseNotesError(`manifest export key is not a subpath: ${subpath}`);
      }
      return `${name}${subpath.slice(1)}`;
    });
}

/**
 * Assemble the generator's input from the trusted checkout's manifest plus the values the publish
 * job verified for itself.
 *
 * Pure: the caller reads the manifest, and this decides what the notes may say about it.
 */
export function sdkReleaseNotesInput({
  manifest,
  tag,
  sourceCommit,
  npmDistTag,
  tarballFilename,
  checksumFilename,
}) {
  if (typeof manifest !== "object" || manifest === null) {
    throw new SdkReleaseNotesError("manifest must be an object");
  }
  return {
    packageName: manifest.name,
    version: manifest.version,
    description: manifest.description,
    nodeEngines: manifest.engines?.node,
    publicEntryPoints: sdkPublicEntryPoints(manifest),
    repositoryUrl: repositoryHttpsUrl(manifest.repository),
    tag,
    sourceCommit,
    npmDistTag,
    tarballFilename,
    checksumFilename,
  };
}

/** The GitHub Release title. `@fairux/sdk v0.1.0-beta.2` doubled the `v` the version already has. */
export function sdkReleaseTitle({ packageName, version }) {
  const name = requireExactly("package name", packageName, SDK_PACKAGE_NAME);
  return `${name} ${requireInertString("version", version)}`;
}

function validateInput(input) {
  const packageName = requireExactly("package name", input.packageName, SDK_PACKAGE_NAME);
  const version = requireInertString("version", input.version);

  // Beta-only, and beta specifically. A prerelease check alone accepts `0.1.0-alpha.1`,
  // `0.1.0-rc.1`, and the purely numeric `0.1.0-1`, while this copy calls the release a beta in
  // the overview, the install section, and the caveats. Either the version says beta or the notes
  // are describing something else.
  const { valid } = classifyVersion(version);
  if (!valid) throw new SdkReleaseNotesError(`version is not valid SemVer: ${version}`);
  if (!isBetaPrerelease(version)) {
    throw new SdkReleaseNotesError(
      `SDK beta release notes require a beta prerelease version, got ${version}`,
    );
  }

  requireExactly("tag", input.tag, `sdk-v${version}`);
  requireExactly("npm dist-tag", input.npmDistTag, SDK_BETA_DIST_TAG);
  requireExactly(
    "tarball filename",
    input.tarballFilename,
    packedTarballName(packageName, version),
  );
  requireExactly("checksum filename", input.checksumFilename, SDK_RELEASE_CHECKSUM_FILE);

  const sourceCommit = requireInertString("source commit", input.sourceCommit);
  if (!COMMIT_SHA.test(sourceCommit)) {
    throw new SdkReleaseNotesError(`source commit is not a full 40-hex SHA: ${sourceCommit}`);
  }

  requireInertString("description", input.description);
  requireInertString("node engines", input.nodeEngines);
  requireExactly("repository url", input.repositoryUrl, repositoryHttpsUrl(input.repositoryUrl));

  const entryPoints = input.publicEntryPoints;
  if (!Array.isArray(entryPoints)) {
    throw new SdkReleaseNotesError("public entry points must be an array");
  }
  for (const entryPoint of entryPoints) requireInertString("public entry point", entryPoint);
  if (entryPoints.join("\n") !== SDK_PUBLIC_ENTRY_POINTS.join("\n")) {
    throw new SdkReleaseNotesError(
      `public entry points must be exactly ${SDK_PUBLIC_ENTRY_POINTS.join(", ")}, got ${
        entryPoints.join(", ") || "none"
      }`,
    );
  }
}

/**
 * Render the GitHub Release body for one SDK beta.
 *
 * Deterministic: same input, same bytes. No filesystem, process, or network access, and no clock —
 * the notes carry no timestamp, so regenerating them for an existing Release produces the body that
 * Release already has.
 *
 * @param {import("./release-notes.d.mts").SdkReleaseNotesInput} input
 * @returns {string} Markdown ending in exactly one newline.
 */
export function generateSdkReleaseNotes(input) {
  validateInput(input);
  const {
    packageName,
    version,
    description,
    nodeEngines,
    publicEntryPoints,
    repositoryUrl,
    tag,
    sourceCommit,
    npmDistTag,
    tarballFilename,
    checksumFilename,
  } = input;

  // Paragraphs, each tagged with the section it belongs to. The section order and the
  // one-heading-per-section rule then come out of the assembly loop below rather than out of
  // whitespace typed into a template literal.
  const paragraphs = [
    ["Overview", `\`${packageName}\` — ${description}`],
    [
      "Overview",
      // What a `Finding` actually carries. `RuleMeta` and its `knownLimitations` live on the
      // RulePack, not in the report, so a reader told the report "returns" them would go looking
      // in the wrong object.
      "FairUX returns findings with evidence, severity, confidence, rule identity, an " +
        "explanation of why the issue matters, and a human-readable recommendation. It does not " +
        "return a fraud, legal, or safety verdict, and no finding count proves that a UI is fair.",
    ],
    ["Install", ["```bash", `npm install ${packageName}@${npmDistTag}`, "```"].join("\n")],
    [
      "Install",
      `The beta is published on the \`${npmDistTag}\` dist-tag. \`latest\` is intentionally ` +
        `unchanged, so a plain \`npm install ${packageName}\` does not pick this release up — ` +
        "opting into the beta stays explicit.",
    ],
    [
      "Highlights",
      [
        "- Deterministic scans of static HTML (`scanHtml`) and of a live DOM (`scanDom`), plus " +
          "reusable scanners (`createHtmlScanner`, `createDomScanner`) for many inputs under one " +
          "policy.",
        "- Built-in and custom RulePack composition, with rule enablement and severity overrides " +
          "validated against the composed rule set rather than accepted as free-form strings.",
        "- Namespaced external taxonomy categories and page contexts, so a RulePack published " +
          "outside FairUX can carry its own vocabulary.",
        // Scoped twice over: to the built-in pack, because a third-party pack's `evaluate()` is
        // ordinary JavaScript, and to one scanner policy, because locale, enabled packs,
        // experimental rules, and overrides all change what the same document produces.
        "- Built-in scanning is local-only: the engine and built-in RulePack make no network or " +
          "AI call. With the same normalized input and the same scanner policy, they yield the " +
          "same findings.",
      ].join("\n"),
    ],
    [
      "Public entry points",
      [
        "| Entry point | Purpose |",
        "| --- | --- |",
        ...publicEntryPoints.map(
          (entryPoint) => `| \`${entryPoint}\` | ${ENTRY_POINT_PURPOSE[entryPoint]} |`,
        ),
      ].join("\n"),
    ],
    [
      "Public entry points",
      // Scoped to this package. The repository has other public contracts — `FairUxReport` is
      // declared one in `docs/fairux-report-schema.md` — so a claim about "this repository"
      // contradicted a document checked in beside it.
      `For \`${packageName}\`, the three code entry points above are the public compatibility ` +
        `contract. \`${packageName}/package.json\` is exported for tooling that reads the ` +
        "manifest; it is not an API.",
    ],
    [
      "Compatibility",
      [
        `- Node.js \`${nodeEngines}\`.`,
        "- The DOM entry point is browser-bundleable from the published package; release " +
          "verification bundles it from the packed tarball rather than from this workspace.",
      ].join("\n"),
    ],
    [
      "Trust and verification",
      [
        "- Published with npm Trusted Publishing over OIDC. This release workflow supplies no " +
          "long-lived npm token: immediately before `npm publish` it verifies that no npm " +
          "credential is present in the job environment or in the project, user, or global npm " +
          "config.",
        "- The npm package carries provenance, so the registry can show which workflow run and " +
          "which commit produced it.",
        `- Built from tag \`${tag}\`, commit \`${sourceCommit}\`.`,
        "- npm's `dist.shasum` and `dist.integrity` are registry metadata for the tarball npm " +
          `serves: \`npm view ${packageName}@${version} dist.integrity\`.`,
        `- \`${checksumFilename}\` on this Release is a SHA-256 checksum for the tarball attached ` +
          "**here**. The two use different digest formats and cover downloads from different " +
          "distribution endpoints; neither is a substitute for the other.",
        "- Third-party RulePacks are trusted executable JavaScript. FairUX does not sandbox them: " +
          "a pack's `evaluate()` may use network, filesystem, or AI access if the environment " +
          "allows it. Pin versions and review the source.",
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
      "Beta caveats",
      [
        "- The public API is beta and may change before a stable release.",
        `- Version \`${version}\` is published on \`${npmDistTag}\`; this release does not move ` +
          "`latest`.",
        "- No coverage-aware risk index and no scoring.",
        "- No baselines and no suppressions.",
        // `Finding.recommendation` is a required field. What does not exist is the machine-
        // applicable kind: a remediation schema, an edit engine, a dry run, and `--write`.
        "- No machine-applicable remediation, no `--fix-dry-run`, and no `--write`; findings " +
          "still include human-readable recommendations.",
        "- No AI review.",
        "- No external product has been proven against the registry-installed package yet; the " +
          "install evidence is this repository's own smoke run.",
        "- Third-party RulePacks are not sandboxed.",
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
export const SDK_RELEASE_NOTES_SCRIPT = "packages/sdk/scripts/release-notes.mjs";

/** The manifest a caller reads the release-variable facts from. */
export const SDK_MANIFEST_PATH = "packages/sdk/package.json";

/**
 * The whole `node` argv for one release's notes, derived from the three values that vary.
 *
 * A caller assembling this list itself is how the release dry run stopped rehearsing the publish
 * job: the CLI's signature changed under it, the dry run kept passing `--version`, and only CI's
 * release preflight noticed. Deriving it here makes a caller's invocation a value a test can
 * compare exactly, rather than option names a test can only find somewhere in a file.
 *
 * The dist-tag comes from the shared version contract — the same helper the release bundle uses to
 * decide where a version publishes — so the notes cannot name a channel the release does not use.
 */
export function sdkReleaseNotesInvocation({ tag, sourceCommit, tarball, out }) {
  const args = [
    SDK_RELEASE_NOTES_SCRIPT,
    "--package-json",
    SDK_MANIFEST_PATH,
    "--tag",
    tag,
    "--source-commit",
    sourceCommit,
    "--dist-tag",
    distTagFor(tag.replace(/^sdk-v/, "")) ?? "",
    "--tarball",
    tarball,
    "--checksum",
    SDK_RELEASE_CHECKSUM_FILE,
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
  const notes = generateSdkReleaseNotes(
    sdkReleaseNotesInput({
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
 * cannot decide it, and `realpathSync` resolves a symlinked entry point — Node already resolves
 * `import.meta.url` that way.
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
