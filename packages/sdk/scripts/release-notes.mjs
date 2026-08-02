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
 * The repository these notes may link into.
 *
 * `repositoryHttpsUrl` only proves a manifest URL has the *shape* `https://github.com/<o>/<r>`, so
 * `https://github.com/attacker/repository` normalized cleanly and every documentation link in the
 * body would have followed it. The Documentation section is absolute links a reader clicks from a
 * published Release; the destination is pinned, not merely well-formed.
 */
export const SDK_REPOSITORY_URL = "https://github.com/toshtag/fairux-linter";

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
  verified,
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
    ...(verified ? { verified } : {}),
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

  // The same `isBetaPrerelease` the release path's gates use, since #68 gave them one meaning.
  // Here it is a presentation guard rather than an eligibility decision: this copy calls the
  // release a beta in the overview, the install section, and the caveats, so a version whose first
  // prerelease identifier is not `beta` is one these notes would misdescribe. The workflow refuses
  // such a version in `validate`, long before this ever runs.
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

  // Booleans, so a truthy string cannot stand in for a check that ran.
  const verified = input.verified;
  if (verified !== undefined) {
    if (typeof verified !== "object" || verified === null || Array.isArray(verified)) {
      throw new SdkReleaseNotesError("verified must be an object");
    }
    for (const [key, value] of Object.entries(verified)) {
      if (typeof value !== "boolean") {
        throw new SdkReleaseNotesError(
          `verified.${key} must be a boolean, got ${typeof value} — a claim in these notes is ` +
            "either something the workflow checked or it is not",
        );
      }
    }
  }

  requireInertString("description", input.description);
  requireInertString("node engines", input.nodeEngines);
  // Normalizing is not enough: a drifted manifest pointing at another GitHub repository normalizes
  // just as cleanly, and every documentation link would follow it.
  requireExactly("repository url", input.repositoryUrl, repositoryHttpsUrl(input.repositoryUrl));
  requireExactly("repository url", input.repositoryUrl, SDK_REPOSITORY_URL);

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
  // Facts the privileged job checked for itself, not defaults. An absent flag narrows the
  // corresponding claim rather than asserting it — the whole of issue #83 is that a generator which
  // was never supplied evidence must not write a past-tense sentence as if it had been.
  const verified = input.verified ?? {};

  // Paragraphs, each tagged with the section it belongs to. The section order and the
  // one-heading-per-section rule then come out of the assembly loop below rather than out of
  // whitespace typed into a template literal.
  const paragraphs = [
    ["Overview", `\`${packageName}\` — ${description}`],
    // The description is the published package's own npm metadata for this exact version, so it is
    // quoted rather than rewritten — changing it here would make the repository and the registry
    // disagree about a version already on npm.
    //
    // It used to promise determinism, and this paragraph bounded that word where the manifest could
    // not be changed. `0.1.0-beta.3` narrowed the description instead (issue #69), so the boundary
    // is now stated on its own terms rather than as a gloss on a word the description no longer
    // carries — it is still worth stating, because determinism is what a reader most wants to know
    // the shape of.
    [
      "Overview",
      "Determinism here means built-in scanning: the same normalized input under the same scanner " +
        "policy produces the same findings. Locale, enabled packs, experimental rules, and rule or " +
        "severity overrides are all part of that policy. Third-party RulePacks are trusted " +
        "executable JavaScript and are outside the guarantee entirely.",
    ],
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
        "- Static HTML (`scanHtml`) and live DOM (`scanDom`) scanning, plus reusable scanners " +
          "(`createHtmlScanner`, `createDomScanner`) for many inputs under one policy.",
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
        // Three separate claims, because they are three separate things and one sentence standing
        // for all of them is how an unverified one rides along with a verified one.
        //
        // Only what the workflow *checked* is asserted. `verified.credentialPreflight` and
        // `verified.provenanceAttested` are supplied by the privileged job from steps that actually
        // ran; without them these lines narrow to what the checkout can support rather than making
        // a past-tense claim the generator was never given evidence for (issue #83).
        // Narrowed to what holds on *every* successful path. The workflow runs the credential check
        // before its first npm registry request and again immediately before publishing — but the
        // second one is conditional on `PUBLISH_NEEDED`, so a rerun that finds the version already
        // present skips it, and there is no check after publication at all. "Immediately before
        // `npm publish`" and "again afterwards" were both untrue for a rerun.
        verified.credentialPreflight
          ? "- This release workflow supplies no long-lived npm token. Before this run's first npm " +
            "registry request, it verified that no npm credential was present in the job " +
            "environment or in the project, user, or global npm configuration."
          : "- This release workflow is configured to supply no long-lived npm token. The " +
            "credential preflight did not report a result to these notes, so treat that as " +
            "unverified for this release.",
        "- The workflow is configured to authenticate through npm Trusted Publishing over OIDC. " +
          "These notes do not infer the authentication path from that configuration; the " +
          "registry's own record of how a version was published is " +
          `\`npm view ${packageName}@${version}\`.`,
        // Narrowed to the shape the read-back actually checks. It reads `dist.attestations` and
        // requires an HTTPS URL and a SLSA provenance predicate. It does not fetch the bundle,
        // verify a signature, or bind the attestation to this run or this commit — so "records
        // which workflow run and which commit produced it" was a claim about the attestation's
        // contents that nothing here opened.
        verified.provenanceAttested
          ? "- npm reports provenance attestation metadata for this exact version, at an HTTPS URL " +
            "and carrying a SLSA provenance predicate. The workflow read that back from the " +
            "registry after publishing rather than assuming it from `--provenance`. It did not " +
            "fetch or verify the attestation bundle, and did not bind it to this workflow run or " +
            "commit; `npm audit signatures` against a clean install is a separate check."
          : "- The publish used `--provenance`, but these notes were written without a read-back " +
            "of the registry's attestation metadata. Whether the registry recorded one is " +
            "unverified here.",
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
export function sdkReleaseNotesInvocation({ tag, sourceCommit, tarball, out, verified }) {
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
  // Named flags rather than one JSON blob: each is a specific check the job either ran or did not,
  // and a caller that has to construct a payload is a caller that can construct a wrong one.
  if (verified?.credentialPreflight) args.push("--verified-credential-preflight");
  if (verified?.provenanceAttested) args.push("--verified-provenance-attested");
  if (out !== undefined) args.push("--out", out);
  return args;
}

/**
 * Flags the privileged job passes for checks it actually ran.
 *
 * Presence-only, and never negatable. There is no `--no-…` form, because "the check ran and failed"
 * is not a state these notes can describe: a failed preflight or a missing attestation fails the
 * job, so the only two states that reach here are "verified" and "not reported".
 */
const VERIFIED_FLAGS = Object.freeze({
  "--verified-credential-preflight": "credentialPreflight",
  "--verified-provenance-attested": "provenanceAttested",
});

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
    if (flag !== undefined && flag in VERIFIED_FLAGS) {
      if (options.has(flag)) throw new UsageError(`repeated argument: ${flag}`);
      options.set(flag, "true");
      continue;
    }
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
      verified: Object.fromEntries(
        Object.entries(VERIFIED_FLAGS)
          .filter(([flag]) => options.has(flag))
          .map(([, key]) => [key, true]),
      ),
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
