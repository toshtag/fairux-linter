import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { CLI_RELEASE_CHECKSUM_FILE } from "../../apps/cli/scripts/cli-release-contract.mjs";
import {
  CLI_MANIFEST_PATH,
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

  it("says a plain global install does not resolve the beta", () => {
    expect(notes).toContain("does not resolve it");
    expect(notes).toContain("`latest` is not set");
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
    expect(notes).toContain("docs/cli-beta-release.md");
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

  it("drops the beta-only caveats but keeps the capability ones", () => {
    expect(stable).not.toContain("may change before a stable release");
    expect(stable).toContain("No coverage-aware risk index");
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
