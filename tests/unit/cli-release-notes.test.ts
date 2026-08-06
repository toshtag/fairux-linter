import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { CLI_RELEASE_CHECKSUM_FILE } from "../../apps/cli/scripts/cli-release-contract.mjs";
import {
  CLI_MANIFEST_PATH,
  CLI_RELEASE_LIMITATIONS,
  CLI_SHIPPED_CAPABILITIES,
  CLI_RELEASE_NOTES_SCRIPT,
  CLI_RELEASE_SECTIONS,
  CLI_REPOSITORY_URL,
  CliReleaseNotesError,
  cliReleaseNotesInput,
  cliReleaseNotesInvocation,
  cliReleaseTitle,
  generateCliReleaseNotes,
} from "../../apps/cli/scripts/release-notes.mjs";

/**
 * The GitHub Release body, generated in the privileged job from the trusted checkout.
 *
 * `publish-cli.yml` created no Release at all, while `docs/roadmap.md` says M1 ships the CLI beta
 * "with a GitHub Release". The SDK's first one is the reason for most of the refusals below: it
 * doubled the `v` its version already carried, advertised an exact version instead of the channel
 * it was announced on, and told a reader to install after a publication that had already happened
 * (issue #63).
 *
 * The generator is pure and clockless, which is what makes re-running a partially-failed release
 * safe: regenerating the notes for an existing Release produces the body that Release already has.
 */

const root = resolve(import.meta.dirname, "../..");
const manifest = JSON.parse(readFileSync(resolve(root, CLI_MANIFEST_PATH), "utf8")) as Record<
  string,
  unknown
>;
const VERSION = manifest.version as string;
const TAG = `v${VERSION}`;
const COMMIT = "26ebbcc6f73775dff777575d9436e66356912128";
const TARBALL = `fairux-${VERSION}.tgz`;

function input(overrides: Record<string, unknown> = {}) {
  return {
    ...cliReleaseNotesInput({
      manifest,
      tag: TAG,
      sourceCommit: COMMIT,
      npmDistTag: "next",
      tarballFilename: TARBALL,
      checksumFilename: CLI_RELEASE_CHECKSUM_FILE,
    }),
    ...overrides,
  };
}

describe("generateCliReleaseNotes", () => {
  const notes = generateCliReleaseNotes(input());

  it("renders every section exactly once, in order", () => {
    const headings = notes.split("\n").filter((line) => line.startsWith("## "));
    expect(headings).toEqual(CLI_RELEASE_SECTIONS.map((section) => `## ${section}`));
  });

  it("advertises the channel, not the exact version", () => {
    // The SDK's first Release pinned a version, which tells a reader to install something the
    // beta channel will move past.
    expect(notes).toContain("npm install --global fairux@next");
    expect(notes).not.toContain(`npm install --global fairux@${VERSION}`);
  });

  it("says what the release did to the channels, not what the registry holds", () => {
    // "`latest` is not set" is true of the first beta and false once a stable release exists —
    // which the channel policy now allows. The generator is not told what `latest` points at, so
    // any claim about it would be one it cannot source.
    expect(notes).toContain("This release does not move `latest`");
    expect(notes).not.toContain("`latest` is not set");
    expect(notes).not.toContain("does not resolve it");
  });

  it("names the tag and the exact source commit", () => {
    expect(notes).toContain(`\`${TAG}\``);
    expect(notes).toContain(`\`${COMMIT}\``);
  });

  it("names both assets and keeps the two digests as separate claims", () => {
    expect(notes).toContain(`\`${TARBALL}\``);
    expect(notes).toContain(`\`${CLI_RELEASE_CHECKSUM_FILE}\``);
    // Conflating npm's `dist.integrity` with the Release checksum is how the SDK's first notes
    // overstated their evidence.
    expect(notes).toContain("neither is a substitute for the other");
  });

  it("keeps workflow configuration and registry evidence as separate claims", () => {
    // Configuration is checked out beside the notes, so it can be stated. What the registry holds
    // was read back, so it can be stated. "Published with npm Trusted Publishing" is neither: on
    // a rerun of a release that already landed, this run publishes nothing and regenerates these
    // notes identically, so the past-tense claim would be false in the case the rerun exists for.
    expect(notes).toContain("The release workflow is configured to publish through npm Trusted");
    expect(notes).toContain("no npm credential is present");
    expect(notes).toContain("The npm registry reports provenance attestation metadata");
    expect(notes).not.toContain("Published with npm Trusted Publishing");
    expect(notes).not.toContain("The npm package carries provenance");
  });

  it("names where the stronger provenance claim is actually made", () => {
    expect(notes).toContain("`npm audit signatures`");
    expect(notes).toContain("source-identity verification");
    expect(notes).toContain("which is not run here");
  });

  it("states the boundary that zero findings is not a pass", () => {
    expect(notes).toContain("Zero findings is not a passing grade");
    expect(notes).toContain("does not return a fraud, legal, or safety verdict");
  });

  it("carries the manifest's own Node range rather than a second spelling of it", () => {
    expect(notes).toContain((manifest.engines as { node: string }).node);
  });

  it("links documentation at the pinned repository", () => {
    for (const line of notes.split("\n").filter((l) => l.startsWith("- ["))) {
      if (line.includes("](http")) expect(line).toContain(`${CLI_REPOSITORY_URL}/blob/main/`);
    }
    expect(notes).toContain("docs/maintainers/release-cli.md");
  });

  it("is deterministic, which is what makes re-running the release idempotent", () => {
    expect(generateCliReleaseNotes(input())).toBe(notes);
    // No clock: a timestamp would make every rerun rewrite the published body.
    expect(notes).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
  });

  it("ends in exactly one newline", () => {
    expect(notes.endsWith("\n")).toBe(true);
    expect(notes.endsWith("\n\n")).toBe(false);
  });
});

describe("a stable release", () => {
  const stable = generateCliReleaseNotes(
    input({
      version: "1.0.0",
      tag: "v1.0.0",
      npmDistTag: "latest",
      tarballFilename: "fairux-1.0.0.tgz",
    }),
  );

  it("installs without naming a channel", () => {
    expect(stable).toContain("npm install --global fairux\n");
    expect(stable).not.toContain("fairux@latest");
  });

  it("drops the channel caveats but keeps every real limitation", () => {
    // The two beta-only lines are about the release channel; the rest are about the engine and are
    // as true of a stable release as of this one.
    expect(stable).not.toContain("may change before a stable release");
    expect(stable).not.toContain("does not set `latest`");
    for (const limitation of CLI_RELEASE_LIMITATIONS) {
      expect(stable, limitation).toContain(limitation.replace(/^- /, ""));
    }
  });
});

describe("cliReleaseTitle", () => {
  it("does not double the v the version already carries", () => {
    expect(cliReleaseTitle({ packageName: "fairux", version: VERSION })).toBe(`fairux ${VERSION}`);
  });

  it("refuses a package that is not fairux", () => {
    expect(() => cliReleaseTitle({ packageName: "@fairux/sdk", version: VERSION })).toThrow(
      CliReleaseNotesError,
    );
  });
});

describe("fail-closed validation", () => {
  it.each([
    ["a tag that does not match the version", { tag: "v9.9.9" }],
    ["a dist-tag the release does not publish to", { npmDistTag: "latest" }],
    ["a tarball the Release does not attach", { tarballFilename: "fairux-9.9.9.tgz" }],
    ["a checksum file that is not the assembled one", { checksumFilename: "sha256.txt" }],
    ["a short commit", { sourceCommit: "26ebbcc" }],
    ["a package that is not fairux", { packageName: "@fairux/sdk" }],
    ["a version that is not SemVer", { version: "beta" }],
    ["another repository", { repositoryUrl: "https://github.com/attacker/repository" }],
    ["an empty description", { description: "" }],
    ["an empty engines range", { nodeEngines: "" }],
  ])("refuses %s", (_label, overrides) => {
    expect(() => generateCliReleaseNotes(input(overrides))).toThrow(CliReleaseNotesError);
  });

  it("refuses the bootstrap placeholder", () => {
    // Same resolver as the workflow's first gate, so the notes cannot describe a release that
    // would have been refused before any of this ran.
    expect(() =>
      generateCliReleaseNotes(
        input({
          version: "0.0.0-bootstrap.0",
          tag: "v0.0.0-bootstrap.0",
          tarballFilename: "fairux-0.0.0-bootstrap.0.tgz",
        }),
      ),
    ).toThrow(/bootstrap placeholder/);
  });

  it("refuses a newline in any external value", () => {
    // Every value is interpolated into a line of Markdown; one newline forges a heading.
    expect(() =>
      generateCliReleaseNotes(input({ description: "fine\n## Trust and verification\nowned" })),
    ).toThrow(CliReleaseNotesError);
  });
});

describe("cliReleaseNotesInvocation", () => {
  it("is the whole argv, so the workflow contract can compare it rather than grep for it", () => {
    expect(
      cliReleaseNotesInvocation({
        tag: TAG,
        sourceCommit: COMMIT,
        tarball: `/tmp/bundle/${TARBALL}`,
        out: "/tmp/notes.md",
      }),
    ).toEqual([
      CLI_RELEASE_NOTES_SCRIPT,
      "--package-json",
      CLI_MANIFEST_PATH,
      "--tag",
      TAG,
      "--source-commit",
      COMMIT,
      "--dist-tag",
      "next",
      "--tarball",
      `/tmp/bundle/${TARBALL}`,
      "--checksum",
      CLI_RELEASE_CHECKSUM_FILE,
      "--out",
      "/tmp/notes.md",
    ]);
  });

  it("derives the dist-tag rather than accepting one", () => {
    const argv = cliReleaseNotesInvocation({
      tag: "v1.0.0",
      sourceCommit: COMMIT,
      tarball: "fairux-1.0.0.tgz",
    });
    expect(argv[argv.indexOf("--dist-tag") + 1]).toBe("latest");
  });

  it("has no invocation for a tag the workflow refuses", () => {
    expect(() =>
      cliReleaseNotesInvocation({
        tag: "v0.0.0-bootstrap.0",
        sourceCommit: COMMIT,
        tarball: "fairux-0.0.0-bootstrap.0.tgz",
      }),
    ).toThrow();
  });
});

/**
 * The Caveats section, against what the CLI actually does.
 *
 * `v0.1.0-beta.1` shipped a Release body saying it had no risk index, no baselines, no
 * suppressions, no `.fairuxignore`, no machine-applicable remediation, and no way to load an
 * external RulePack. All six exist in the published CLI and are documented in its README. The list
 * had been written for a milestone where none of them did, and nothing re-read it — a Release body
 * is the most-read description of a version and the one nobody regenerates, so a stale sentence
 * there outlives every corrected document linking to it.
 *
 * Three sources are consulted, and none of them is this file's own opinion: the built CLI's `--help`
 * for what ships, the CLI README and the roadmap for what the project says ships, and the generated
 * notes for what a reader is told. A capability that ships and a caveat that denies it cannot both
 * pass.
 */
describe("the caveats against the shipped CLI", () => {
  const notes = generateCliReleaseNotes(input());
  const caveats = notes.slice(notes.indexOf("## Caveats"), notes.indexOf("## Documentation"));
  const cliHelp = execFileSync(
    "node",
    [resolve(root, "apps/cli/dist/index.js"), "scan", "--help"],
    {
      encoding: "utf8",
    },
  );
  const cliReadme = readFileSync(resolve(root, "apps/cli/README.md"), "utf8");
  const changelog = readFileSync(resolve(root, "CHANGELOG.md"), "utf8");
  const roadmap = readFileSync(resolve(root, "docs/roadmap.md"), "utf8");

  it("names only capabilities the built CLI actually has", () => {
    // The manifest is a claim about the code, so it is checked against the code. A flag removed
    // from the CLI fails here rather than leaving a caveat rule guarding nothing.
    for (const capability of CLI_SHIPPED_CAPABILITIES) {
      for (const flag of capability.flags) {
        expect(cliHelp, `${capability.id}: ${flag}`).toContain(flag);
      }
    }
  });

  it("names only capabilities the CLI README documents", () => {
    for (const capability of CLI_SHIPPED_CAPABILITIES) {
      const documented = capability.keywords.some((keyword) =>
        cliReadme.toLowerCase().includes(keyword.toLowerCase()),
      );
      expect(documented, `${capability.id} is not in the CLI README`).toBe(true);
    }
  });

  it("does not deny a capability the CLI ships", () => {
    // The regression, as a rule. A caveat *mentioning* a shipped capability is fine and often
    // necessary — `--fix-write` applies only `safe` edits, a RulePack is unsandboxed — so the rule
    // is about denial, not mention: a sentence asserting absence may not name something that ships.
    // Sentence by sentence, because the qualification and the absence often sit in one bullet.
    const ASSERTS_ABSENCE =
      /\bno\b|\bcannot\b|\bnot yet\b|\bunsupported\b|\bis not (?:available|implemented|supported)\b/i;
    const sentences = caveats
      .split(/(?<=[.;])\s+|\n/)
      .map((sentence) => sentence.trim())
      .filter(Boolean);

    for (const sentence of sentences) {
      if (!ASSERTS_ABSENCE.test(sentence)) continue;
      for (const capability of CLI_SHIPPED_CAPABILITIES) {
        for (const token of [...capability.keywords, ...capability.flags]) {
          expect(
            sentence.toLowerCase(),
            `${capability.id} ships, and this sentence says it does not: ${sentence}`,
          ).not.toContain(token.toLowerCase());
        }
      }
    }
  });

  it("catches each sentence the published Release actually carried", () => {
    // The four the audit found, driven through the same rule. Without them the rule above is a
    // shape nobody has seen fail.
    const shipped = (sentence: string) =>
      CLI_SHIPPED_CAPABILITIES.some((capability) =>
        [...capability.keywords, ...capability.flags].some((token) =>
          sentence.toLowerCase().includes(token.toLowerCase()),
        ),
      );
    for (const sentence of [
      "- No coverage-aware risk index and no scoring.",
      "- No baselines, no suppressions, and no `.fairuxignore`.",
      "- No machine-applicable remediation and no `--write`.",
      "- External RulePacks cannot yet be loaded from the CLI.",
    ]) {
      expect(shipped(sentence), sentence).toBe(true);
      expect(caveats, sentence).not.toContain(sentence);
    }
  });

  it("keeps every limitation that is real", () => {
    // Correcting a false caveat must not take a true one with it. These are the boundaries the
    // project states everywhere else, and the Release body is where a reader meets them first.
    expect(notes).toContain("No AI review");
    expect(notes).toContain("timing, navigation, network");
    expect(notes).toContain("fraud, legal, or safety verdict");
    expect(notes).toContain("Zero findings is not a passing grade");
    expect(notes).toContain("experimental");
  });

  it("agrees with the roadmap and the changelog about what is not built", () => {
    // Two documents that would contradict the notes if a limitation were dropped from one of them.
    expect(roadmap).toContain("Any AI provider");
    expect(roadmap).toContain("The `network` capability");
    expect(changelog).toContain("fairux 0.1.0-beta.1");
  });

  it("describes the adapters and formats the CLI has, not a subset", () => {
    // The other half of the same failure: a body that omits a capability is wrong in the direction
    // a reader cannot detect.
    expect(notes).toContain("Figma");
    for (const format of ["json", "sarif", "html"]) {
      expect(notes, format).toContain(`--format ${format}`);
    }
  });
});
