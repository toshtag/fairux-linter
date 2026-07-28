import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import {
  generateSdkReleaseNotes,
  repositoryHttpsUrl,
  SDK_BETA_DIST_TAG,
  SDK_PUBLIC_ENTRY_POINTS,
  SDK_RELEASE_CHECKSUM_FILE,
  SDK_RELEASE_SECTIONS,
  SdkReleaseNotesError,
  sdkPublicEntryPoints,
  sdkReleaseNotesInput,
  sdkReleaseNotesInvocation,
  sdkReleaseTitle,
} from "../scripts/release-notes.mjs";

/**
 * The Release body is prose, which is exactly why it needs a contract.
 *
 * The `sdk-v0.1.0-beta.2` notes were wrong in ways no test could have caught, because there was
 * nothing to catch: a template literal said "Install after publication" of a published package and
 * named an exact version instead of the channel. Every claim the generator now makes is pinned
 * here to the fact it comes from, and every value it must refuse has a case.
 *
 * Two limits are stated rather than implied. A `not.toContain` proves the absence of a string and
 * nothing about the meaning of the surrounding sentence — the prohibited-wording block below says
 * so. And the "no network" assertions read source text; they are not a runtime sandbox.
 */

const scriptsDir = resolve(import.meta.dirname, "../scripts");
const root = resolve(import.meta.dirname, "../../..");
const generator = join(scriptsDir, "release-notes.mjs");
const manifestPath = resolve(import.meta.dirname, "../package.json");

type Manifest = {
  name: string;
  version: string;
  description: string;
  engines: { node: string };
  exports: Record<string, unknown>;
  repository: { url: string };
};

const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Manifest;

const TAG = `sdk-v${manifest.version}`;
const COMMIT = "516b2473a7adaa24dd250ec20f916cf53bd9fa28";
const TARBALL = `fairux-sdk-${manifest.version}.tgz`;

const inputFrom = (overrides: Partial<Manifest> = {}) =>
  sdkReleaseNotesInput({
    manifest: { ...manifest, ...overrides },
    tag: TAG,
    sourceCommit: COMMIT,
    npmDistTag: SDK_BETA_DIST_TAG,
    tarballFilename: TARBALL,
    checksumFilename: SDK_RELEASE_CHECKSUM_FILE,
  });

const BASE = inputFrom();
const notes = generateSdkReleaseNotes(BASE);

const headings = notes
  .split("\n")
  .filter((line) => line.startsWith("## "))
  .map((line) => line.slice(3));

describe("SDK release notes — the generator is pure", () => {
  it("runs nothing when imported", () => {
    // The CLI used to be the module body, so any importer executed it. A test could not have held
    // the generator without also writing a file or printing to stdout.
    const url = pathToFileURL(generator).href;
    const output = execFileSync(
      process.execPath,
      ["--input-type=module", "-e", `await import(${JSON.stringify(url)});`],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );

    expect(output).toBe("");
  });

  it("returns the same bytes for the same input", () => {
    expect(generateSdkReleaseNotes(BASE)).toBe(notes);
  });

  it("contains no direct clock or network API spellings", () => {
    // A source-spelling check only. It is not a runtime sandbox and does not prove the imported
    // modules are side-effect free. It deliberately says nothing about `process`: the CLI at the
    // bottom of the file reads `process.argv` and writes `process.stdout`.
    const source = readFileSync(generator, "utf8");
    for (const forbidden of [
      "node:http",
      "node:https",
      "node:net",
      "fetch(",
      "Date.now",
      "new Date",
    ]) {
      expect(source).not.toContain(forbidden);
    }
  });

  it("ends in exactly one newline", () => {
    expect(notes.endsWith("\n")).toBe(true);
    expect(notes.endsWith("\n\n")).toBe(false);
    expect(notes.trimEnd()).toBe(notes.slice(0, -1));
  });
});

describe("SDK release notes — the section contract", () => {
  it("emits every required section, in order, once each", () => {
    expect(headings).toEqual([...SDK_RELEASE_SECTIONS]);
  });

  it("emits no heading level other than the section headings", () => {
    const anyHeading = notes.split("\n").filter((line) => /^#{1,6} /.test(line));
    expect(anyHeading).toEqual(SDK_RELEASE_SECTIONS.map((section) => `## ${section}`));
  });

  it("separates every section with exactly one blank line", () => {
    expect(notes).not.toContain("\n\n\n");
  });
});

describe("SDK release notes — what each section states", () => {
  it("installs from the beta channel, not from a pinned version", () => {
    expect(notes).toContain("```bash\nnpm install @fairux/sdk@next\n```");
    expect(notes).not.toContain(`npm install @fairux/sdk@${manifest.version}`);
  });

  it("says `latest` is intentionally unchanged", () => {
    expect(notes).toContain("`latest` is intentionally unchanged");
  });

  it("describes what a finding carries, not what the RulePack carries", () => {
    // `Finding` holds rule identity, severity, confidence, evidence, `whyItMatters`, and
    // `recommendation`. `RuleMeta` and its `knownLimitations` are on the RulePack; `FairUxReport`
    // does not return them, so a reader told otherwise would look in the wrong object.
    expect(notes).toContain(
      "FairUX returns findings with evidence, severity, confidence, rule identity",
    );
    expect(notes).toContain("an explanation of why the issue matters");
    expect(notes).toContain("a human-readable recommendation");
    expect(notes).not.toContain("rule metadata, and stated limitations");
  });

  it("scopes deterministic execution to the built-in pack and one scanner policy", () => {
    // Same document, different locale or overrides or enabled packs — different findings. And a
    // third-party pack's `evaluate()` is ordinary JavaScript, which the Trust section covers.
    expect(notes).toContain("Built-in scanning is local-only");
    expect(notes).toContain("With the same normalized input and the same scanner policy");
    expect(notes).not.toContain("the same normalized input yields the same findings");
  });

  it("scopes the compatibility contract to this package's entry points", () => {
    // `docs/fairux-report-schema.md` declares `FairUxReport` a public API, so a claim about the
    // whole repository contradicted a document checked in beside these notes.
    expect(notes).toContain(
      "For `@fairux/sdk`, the three code entry points above are the public compatibility contract.",
    );
    expect(notes).not.toContain("Nothing else in this repository is a public compatibility");
  });

  it("separates human-readable recommendations from machine-applicable remediation", () => {
    // `Finding.recommendation` is required. What P17 would add is the applicable kind.
    expect(notes).toContain("No machine-applicable remediation");
    expect(notes).toContain("findings still include human-readable recommendations");
    expect(notes).not.toContain("- No remediation,");
  });

  it("lists exactly the three public entry points, and not the manifest export", () => {
    const rows = notes
      .split("\n")
      .filter((line) => line.startsWith("| `@fairux/sdk"))
      .map((line) => line.split("|")[1]?.trim());

    expect(rows).toEqual(SDK_PUBLIC_ENTRY_POINTS.map((entry) => `\`${entry}\``));
    expect(rows).toHaveLength(3);
    expect(notes).not.toContain("| `@fairux/sdk/package.json` |");
  });

  it("reads Node support from the manifest rather than repeating a literal", () => {
    expect(notes).toContain(`Node.js \`${manifest.engines.node}\`.`);

    const shifted = generateSdkReleaseNotes(inputFrom({ engines: { node: ">=30.0.0" } }));
    expect(shifted).toContain("Node.js `>=30.0.0`.");
    expect(shifted).not.toContain(manifest.engines.node);
  });

  it("names the tag and the commit it was built from", () => {
    expect(notes).toContain(`Built from tag \`${TAG}\`, commit \`${COMMIT}\`.`);
  });

  it("describes both attached assets", () => {
    expect(notes).toContain(`| \`${TARBALL}\` | The \`@fairux/sdk\` package tarball`);
    expect(notes).toContain(`| \`${SDK_RELEASE_CHECKSUM_FILE}\` | \`<sha256>  <filename>\``);
  });

  it("claims about npm tokens only what this workflow can be seen to do", () => {
    // "No long-lived npm token exists for this package" is not establishable from here: it would
    // have to hold across the npm account, the org, any other CI, and every maintainer's machine.
    // What the workflow shows is that it supplies none and checks for none before publishing.
    expect(notes).toContain("This release workflow supplies no long-lived npm token");
    expect(notes).toContain("no npm credential is present in the job environment");
    expect(notes).not.toContain("No long-lived npm token exists for this package");
  });

  it("distinguishes the Release checksum from npm's integrity without inventing a difference", () => {
    // What actually differs is the digest format and the endpoint a reader downloads from — not
    // the bytes. The workflow hands the same audited `$TARBALL` to `npm publish` and to
    // `gh release`, and `release-registry-plan.mjs` verifies the registry's shasum and integrity
    // against that same local file. "A different file" was a claim in the wrong direction.
    expect(notes).toContain("`dist.shasum` and `dist.integrity` are registry metadata");
    expect(notes).toContain(
      `\`${SDK_RELEASE_CHECKSUM_FILE}\` on this Release is a SHA-256 checksum for the tarball attached **here**.`,
    );
    expect(notes).toContain("different digest formats");
    expect(notes).toContain("different distribution endpoints");
    expect(notes).toContain("neither is a substitute for the other");
    expect(notes).not.toContain("different file");
  });

  it("scopes the dist-tag caveat to this version rather than to the package", () => {
    // `@fairux/sdk` carries `next`, `latest`, and `bootstrap`. "Published on `next` only" was a
    // claim about the package; what holds is a claim about this version.
    expect(notes).toContain(
      `Version \`${manifest.version}\` is published on \`${SDK_BETA_DIST_TAG}\`; this release does not move \`latest\`.`,
    );
    expect(notes).not.toContain(`The package is published on \`${SDK_BETA_DIST_TAG}\` only.`);
  });

  it("states that third-party RulePacks are not sandboxed", () => {
    expect(notes).toContain("FairUX does not sandbox them");
    expect(notes).toContain("Third-party RulePacks are not sandboxed.");
  });

  it("links documentation absolutely, into this repository", () => {
    const links = [...notes.matchAll(/^- \[[^\]]+\]\(([^)]+)\)$/gm)].map((match) => match[1] ?? "");
    expect(links.length).toBeGreaterThanOrEqual(5);
    for (const link of links) {
      expect(link).toMatch(/^https:\/\/github\.com\/toshtag\/fairux-linter\/blob\/main\//);
    }
    expect(notes).not.toMatch(/\]\((?!https:\/\/)/);
  });

  it("links documentation that exists in this repository", () => {
    const links = [...notes.matchAll(/^- \[[^\]]+\]\(([^)]+)\)$/gm)].map((match) => match[1] ?? "");
    for (const link of links) {
      const path = link.replace("https://github.com/toshtag/fairux-linter/blob/main/", "");
      expect(() => readFileSync(resolve(root, path), "utf8"), path).not.toThrow();
    }
  });
});

describe("SDK release notes — the title", () => {
  it("does not duplicate the version's own prefix", () => {
    expect(sdkReleaseTitle({ packageName: "@fairux/sdk", version: manifest.version })).toBe(
      `@fairux/sdk ${manifest.version}`,
    );
    expect(
      sdkReleaseTitle({ packageName: "@fairux/sdk", version: manifest.version }),
    ).not.toContain(`v${manifest.version}`);
  });

  it("refuses to title a release of another package", () => {
    expect(() => sdkReleaseTitle({ packageName: "fairux", version: manifest.version })).toThrow(
      SdkReleaseNotesError,
    );
  });
});

describe("SDK release notes — the values it refuses", () => {
  const reject = (overrides: Record<string, unknown>) =>
    expect(() => generateSdkReleaseNotes({ ...BASE, ...overrides })).toThrow(SdkReleaseNotesError);

  it("refuses another package name", () => reject({ packageName: "fairux" }));

  it("refuses a tag that does not match the version", () => reject({ tag: "sdk-v0.1.0-beta.1" }));

  it.each(["beta", "1.0.0", "0.1.0-alpha.1", "0.1.0-rc.1", "0.1.0-1"])(
    "refuses %s, which this copy would describe as a beta",
    (version) =>
      reject({
        version,
        tag: `sdk-v${version}`,
        tarballFilename: `fairux-sdk-${version}.tgz`,
      }),
  );

  it.each(["0.1.0-beta", "0.1.0-beta.1", "9.9.9-beta.42"])("accepts %s", (version) => {
    expect(() =>
      generateSdkReleaseNotes({
        ...BASE,
        version,
        tag: `sdk-v${version}`,
        tarballFilename: `fairux-sdk-${version}.tgz`,
      }),
    ).not.toThrow();
  });

  it("refuses a dist-tag other than the beta channel", () => reject({ npmDistTag: "latest" }));

  it("refuses a tarball name the manifest does not imply", () =>
    reject({ tarballFilename: "fairux-sdk-0.1.0-beta.1.tgz" }));

  it("refuses a checksum file the bundle does not carry", () =>
    reject({ checksumFilename: "sha256.txt" }));

  it("refuses a source commit that is not a full SHA", () => reject({ sourceCommit: "516b247" }));

  it("refuses a missing entry point", () =>
    reject({ publicEntryPoints: ["@fairux/sdk", "@fairux/sdk/html"] }));

  it("refuses an extra entry point", () =>
    reject({ publicEntryPoints: [...SDK_PUBLIC_ENTRY_POINTS, "@fairux/sdk/internal"] }));

  it("refuses reordered entry points", () =>
    reject({ publicEntryPoints: [...SDK_PUBLIC_ENTRY_POINTS].reverse() }));

  it("refuses a repository URL that is not this repository's host shape", () =>
    reject({ repositoryUrl: "https://example.com/toshtag/fairux-linter" }));

  it.each([
    ["description", "A newline\nin prose"],
    ["nodeEngines", ">=24\u0000"],
    ["sourceCommit", `${COMMIT}\t`],
    ["tarballFilename", `${TARBALL}\u007f`],
    ["repositoryUrl", "https://github.com/toshtag/fairux-linter\r"],
  ])("refuses a %s carrying a newline or control character", (field, value) =>
    reject({ [field]: value }),
  );

  it.each(["description", "nodeEngines", "version", "sourceCommit"])(
    "refuses a missing %s",
    (field) => reject({ [field]: undefined }),
  );
});

describe("SDK release notes — deriving input from a manifest", () => {
  it("derives the entry points this repository actually exports", () => {
    expect(sdkPublicEntryPoints(manifest)).toEqual([...SDK_PUBLIC_ENTRY_POINTS]);
  });

  it("fails when the manifest gains a subpath export nobody decided about", () => {
    // Adding `./internal` to `exports` publishes it. The notes then have to say so, or this fails.
    expect(() =>
      generateSdkReleaseNotes(
        inputFrom({ exports: { ...manifest.exports, "./internal": "./dist/internal.js" } }),
      ),
    ).toThrow(SdkReleaseNotesError);
  });

  it("normalizes the manifest's git URL to a followable one", () => {
    expect(repositoryHttpsUrl(manifest.repository)).toBe(
      "https://github.com/toshtag/fairux-linter",
    );
    expect(repositoryHttpsUrl("https://github.com/toshtag/fairux-linter")).toBe(
      "https://github.com/toshtag/fairux-linter",
    );
  });

  it.each([
    "git@github.com:toshtag/fairux-linter.git",
    "https://user:token@github.com/toshtag/fairux-linter.git",
    "https://gitlab.com/toshtag/fairux-linter.git",
    "https://github.com/toshtag",
  ])("refuses %s", (url) => {
    expect(() => repositoryHttpsUrl(url)).toThrow(SdkReleaseNotesError);
  });

  it("matches the manifest this repository ships", () => {
    // Drift in the released name, version, or export surface fails here rather than in a Release.
    expect(manifest.name).toBe("@fairux/sdk");
    expect(BASE.tag).toBe(`sdk-v${manifest.version}`);
    expect(BASE.description).toBe(manifest.description);
    expect(BASE.nodeEngines).toBe(manifest.engines.node);
  });
});

describe("SDK release notes — wording the published Release must not carry", () => {
  // What each assertion proves is that the exact string is absent. It does not prove the
  // surrounding sentence is true; the section assertions above carry that weight.
  it.each([
    "Install after publication",
    "has not yet been published",
    "publish-ready preview",
    `@fairux/sdk v${manifest.version}`,
    "third-party RulePacks are sandboxed",
    "release-sha256.txt is npm integrity",
  ])("does not contain %s", (phrase) => {
    expect(notes).not.toContain(phrase);
  });
});

describe("SDK release notes — the checksum filename, spelled once per layer", () => {
  it("agrees with the assembler that writes it and the contract that requires it", () => {
    // The CLI bundle once wrote `tarball-sha256.txt` while its verifier read another name. These
    // notes are a third place the name appears, and a reader follows it to an attached file.
    for (const file of [
      "scripts/assemble-release-bundle.mjs",
      "scripts/release-bundle-contract.mjs",
    ]) {
      expect(readFileSync(resolve(root, file), "utf8")).toContain(`"${SDK_RELEASE_CHECKSUM_FILE}"`);
    }
  });
});

describe("SDK release notes — the invocation callers make", () => {
  // An earlier version of this suite searched `release-dry-run.mjs` for each option name. That
  // could not tell an argument from a comment, could not see an option paired with the wrong value,
  // and could not see the order change — so it did not pin a signature at all. The argv is a value
  // now, and this compares the whole of it.
  const TARBALL_PATH = `/tmp/fairux-sdk-release/${TARBALL}`;

  it("derives the whole argv from the tag, the commit, and the tarball", () => {
    expect(
      sdkReleaseNotesInvocation({ tag: TAG, sourceCommit: COMMIT, tarball: TARBALL_PATH }),
    ).toEqual([
      "packages/sdk/scripts/release-notes.mjs",
      "--package-json",
      "packages/sdk/package.json",
      "--tag",
      TAG,
      "--source-commit",
      COMMIT,
      "--dist-tag",
      SDK_BETA_DIST_TAG,
      "--tarball",
      TARBALL_PATH,
      "--checksum",
      SDK_RELEASE_CHECKSUM_FILE,
    ]);
  });

  it("appends --out only when a destination is given", () => {
    const withoutOut = sdkReleaseNotesInvocation({
      tag: TAG,
      sourceCommit: COMMIT,
      tarball: TARBALL_PATH,
    });
    expect(withoutOut).not.toContain("--out");
    expect(
      sdkReleaseNotesInvocation({
        tag: TAG,
        sourceCommit: COMMIT,
        tarball: TARBALL_PATH,
        out: "/tmp/notes.md",
      }),
    ).toEqual([...withoutOut, "--out", "/tmp/notes.md"]);
  });

  it("takes the dist-tag from the shared version contract, not from a literal", () => {
    // A stable tag would name `latest`, which the generator then refuses — the mismatch surfaces
    // as a rejected release rather than as notes advertising the wrong channel.
    const stable = sdkReleaseNotesInvocation({
      tag: "sdk-v1.0.0",
      sourceCommit: COMMIT,
      tarball: TARBALL_PATH,
    });
    expect(stable[stable.indexOf("--dist-tag") + 1]).toBe("latest");
  });

  it("is what the release dry run actually runs", () => {
    // Not a search for option names: the dry run has to hand this function's result to `node`.
    const dryRun = readFileSync(join(scriptsDir, "release-dry-run.mjs"), "utf8");
    expect(dryRun).toContain(
      'runSync("node", sdkReleaseNotesInvocation({ tag, sourceCommit: commit, tarball })',
    );
    expect(dryRun).not.toContain("--version");
  });
});

describe("SDK release notes — the post-merge runbook", () => {
  // The in-place correction of the published Release is run by a maintainer, not by a runner.
  // `$RUNNER_TEMP` is unset there, so `--out "$RUNNER_TEMP/sdk-release-notes.md"` would have
  // written to `/sdk-release-notes.md`. This pins the scratch directory the section documents; it
  // does not execute the section or check anything else about it.
  const section =
    readFileSync(resolve(root, "docs/sdk-beta-release.md"), "utf8")
      .split("#### Release presentation — issue #63")[1]
      ?.split("\n### ")[0] ?? "";

  // Only what the section tells a maintainer to run. The prose around it names the forbidden
  // commands in order to rule them out, so asserting over the whole section would read that
  // explanation as an instruction.
  const commands = [...section.matchAll(/```bash\n([\s\S]*?)```/g)]
    .map((match) => match[1])
    .join("\n");

  it("documents the in-place update", () => {
    expect(section).not.toBe("");
    expect(commands).toContain("gh release edit sdk-v0.1.0-beta.2");
  });

  it("writes the notes into a scratch directory it creates and removes", () => {
    expect(commands).toContain("work=$(mktemp -d)");
    expect(commands).toContain(`trap 'rm -rf "$work"' EXIT`);
    expect(commands).toContain('--out "$work/sdk-release-notes.md"');
    expect(commands).toContain('--notes-file "$work/sdk-release-notes.md"');
    // Unset outside Actions: `--out "$RUNNER_TEMP/…"` would have written to the filesystem root.
    expect(commands).not.toContain("RUNNER_TEMP");
  });

  it("runs none of the commands that would change published state", () => {
    for (const forbidden of [
      "gh release upload",
      "gh release delete",
      "gh release create",
      "npm publish",
      "npm dist-tag",
      "git tag -f",
      "git push --force",
    ]) {
      expect(commands).not.toContain(forbidden);
    }
  });
});

describe("SDK release notes — the CLI", () => {
  const argsFor = (packageJson: string) => [
    "--package-json",
    packageJson,
    "--tag",
    TAG,
    "--source-commit",
    COMMIT,
    "--dist-tag",
    SDK_BETA_DIST_TAG,
    "--tarball",
    // An absolute path, as the workflow passes it: the notes name the file, not the runner's path.
    `/tmp/bundle/${TARBALL}`,
    "--checksum",
    `/tmp/bundle/${SDK_RELEASE_CHECKSUM_FILE}`,
  ];

  const args = argsFor(manifestPath);

  const runCli = (extra: string[] = []) =>
    execFileSync(process.execPath, [generator, ...args, ...extra], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });

  it("writes the generator's output to stdout", () => {
    expect(runCli()).toBe(notes);
  });

  it("writes the same bytes to --out", () => {
    const out = join(mkdtempSync(join(tmpdir(), "fairux-release-notes-")), "notes.md");
    expect(runCli(["--out", out])).toBe("");
    expect(readFileSync(out, "utf8")).toBe(notes);
  });

  it("exits 2 on a malformed invocation", () => {
    for (const invocation of [
      [],
      ["--tag"],
      [...args, "--unknown", "x"],
      [...args, "--tag", TAG],
    ]) {
      let status: number | undefined;
      try {
        execFileSync(process.execPath, [generator, ...invocation], { stdio: "pipe" });
      } catch (error) {
        status = (error as { status?: number }).status;
      }
      expect(status, JSON.stringify(invocation)).toBe(2);
    }
  });

  it("exits 1 when the manifest and the tag disagree", () => {
    const drifted = join(mkdtempSync(join(tmpdir(), "fairux-release-notes-")), "package.json");
    writeFileSync(drifted, JSON.stringify({ ...manifest, version: "0.1.0-beta.9" }), "utf8");

    let status: number | undefined;
    let stderr = "";
    try {
      execFileSync(process.execPath, [generator, ...argsFor(drifted)], { stdio: "pipe" });
    } catch (error) {
      status = (error as { status?: number }).status;
      stderr = String((error as { stderr?: Buffer }).stderr ?? "");
    }

    expect(status).toBe(1);
    expect(stderr).toContain("tag must be sdk-v0.1.0-beta.9");
  });
});
