import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import {
  generateSdkReleaseNotes,
  repositoryHttpsUrl,
  SDK_RELEASE_CHECKSUM_FILE,
  SDK_RELEASE_SECTIONS,
  SdkReleaseNotesError,
  sdkPublicEntryPoints,
  sdkReleaseNotesInput,
  sdkReleaseNotesInvocation,
  sdkReleaseTitle,
} from "../scripts/release-notes.mjs";
import { resolveSdkRelease, sdkReleaseTag } from "../scripts/sdk-release-contract.mjs";

/**
 * The Release body is prose, which is exactly why it needs a contract.
 *
 * The `sdk-v0.1.0-beta.2` notes were wrong in ways no test could have caught, because there was
 * nothing to catch: a template literal said "Install after publication" of a published package and
 * named an exact version instead of the channel. Release-variable facts and the load-bearing
 * explanatory claims are pinned here — not every sentence of the copy — and every value the
 * generator must refuse has a case.
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

// Derived from the manifest, like every other consumer of the set. This file used to import a frozen
// array of three specifiers and compare the notes against it, which proved the notes agreed with a
// literal in the module under test rather than with what the package publishes.
const ENTRY_POINTS = sdkPublicEntryPoints(manifest);

const TAG = `sdk-v${manifest.version}`;
const COMMIT = "516b2473a7adaa24dd250ec20f916cf53bd9fa28";
const TARBALL = `fairux-sdk-${manifest.version}.tgz`;
// Derived, not the constant `next` this file used to import. The generator refuses a channel the
// release does not publish to, so pinning the literal would have made every case here fail on the
// day the manifest went stable — which is the day the notes most need to be checked.
const DIST_TAG = resolveSdkRelease(TAG).distTag;

/** What the privileged job reports when its preflight and provenance read-back both ran. */
const VERIFIED = { credentialPreflight: true, provenanceAttested: true } as const;

const inputFrom = (
  overrides: Partial<Manifest> = {},
  verified: Record<string, boolean> = { ...VERIFIED },
) =>
  sdkReleaseNotesInput({
    manifest: { ...manifest, ...overrides },
    tag: TAG,
    sourceCommit: COMMIT,
    npmDistTag: DIST_TAG,
    tarballFilename: TARBALL,
    checksumFilename: SDK_RELEASE_CHECKSUM_FILE,
    verified,
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
  it("installs from this release's channel, not from a pinned version", () => {
    // A prerelease names its channel; a stable release is what a bare install resolves, so naming
    // the tag there would be noise. Either way the exact version is never the install command —
    // `sdk-v0.1.0-beta.2` shipped one, which pins a reader to a version rather than a channel.
    const expected =
      DIST_TAG === "latest" ? "npm install @fairux/sdk" : `npm install @fairux/sdk@${DIST_TAG}`;
    expect(notes).toContain(`\`\`\`bash\n${expected}\n\`\`\``);
    expect(notes).not.toContain(`npm install @fairux/sdk@${manifest.version}`);
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

  it("states the shape of determinism rather than glossing a word in the description", () => {
    // Until `0.1.0-beta.3` the manifest description promised determinism outright, and this
    // paragraph bounded that word where the manifest could not be changed. #69 narrowed the
    // description instead, so quoting it would now quote something that is not there — but the
    // boundary is still what a reader most wants the shape of, so it is stated on its own terms.
    expect(notes).toContain("Determinism here means built-in scanning");
    expect(notes).toContain("same scanner policy produces the same findings");
    expect(notes).toContain("Third-party RulePacks are trusted executable JavaScript");
    expect(notes).not.toContain("In that published description");
  });

  it("does not call scanning deterministic in the highlights", () => {
    expect(notes).toContain("- Static HTML (`scanHtml`) and live DOM (`scanDom`) scanning");
    expect(notes).not.toContain("- Deterministic scans of static HTML");
  });

  it("scopes deterministic execution to the built-in pack and one scanner policy", () => {
    // Same document, different locale or overrides or enabled packs — different findings. And a
    // third-party pack's `evaluate()` is ordinary JavaScript, which the Trust section covers.
    expect(notes).toContain("Built-in scanning is local-only");
    expect(notes).toContain("With the same normalized input and the same scanner policy");
    expect(notes).not.toContain("the same normalized input yields the same findings");
  });

  it("scopes the compatibility contract to this package's entry points", () => {
    // `docs/reference/report-schema.md` declares `FairUxReport` a public API, so a claim about the
    // whole repository contradicted a document checked in beside these notes.
    expect(notes).toContain(
      "For `@fairux/sdk`, the code entry points above are the public compatibility contract — all of them, and only those.",
    );
    expect(notes).not.toContain("Nothing else in this repository is a public compatibility");
  });

  it("separates human-readable recommendations from machine-applicable remediation", () => {
    // `Finding.recommendation` is required. What P17 would add is the applicable kind.
    expect(notes).toContain("No machine-applicable remediation");
    expect(notes).toContain("findings still include human-readable recommendations");
    expect(notes).not.toContain("- No remediation,");
  });

  it("lists exactly the published entry points, and not the manifest export", () => {
    const rows = notes
      .split("\n")
      .filter((line) => line.startsWith("| `@fairux/sdk"))
      .map((line) => line.split("|")[1]?.trim());

    expect(rows).toEqual(ENTRY_POINTS.map((entry) => `\`${entry}\``));
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
    expect(notes).toContain("no npm credential was present in the job environment");
    expect(notes).not.toContain("No long-lived npm token exists for this package");
  });

  /**
   * Issue #83. The generator emitted "Published with npm Trusted Publishing over OIDC" from
   * version-controlled prose while never being supplied a result proving it — so the notes asserted
   * something nobody had checked, and the three things that sentence stood for could not be told
   * apart.
   */
  describe("claims are derived from what the workflow verified", () => {
    const unverified = generateSdkReleaseNotes(inputFrom({}, {}));

    /**
     * The verified wording has to hold on **every** successful path, not on the happy one.
     *
     * The workflow runs the credential check before its first npm registry request and again
     * immediately before publishing — but the second is conditional on `PUBLISH_NEEDED`, so a rerun
     * that finds the version already present skips it, and there is no check after publication at
     * all. The notes said "Immediately before `npm publish` … and it verified this again
     * afterwards", and a rerun made both halves false while the flag was still passed.
     */
    it("claims the credential check only where it always runs", () => {
      expect(notes).toContain("Before this run's first npm registry request");
      for (const forbidden of [
        "Immediately before `npm publish`",
        "again afterwards",
        "before and after publishing",
        "after publication",
      ]) {
        expect(notes, forbidden).not.toContain(forbidden);
      }
    });

    /**
     * `verify-sdk-provenance.mjs` reads `dist.attestations` and requires an HTTPS URL and a SLSA
     * provenance predicate. It does not open the bundle, so anything about what the attestation
     * *says* — which run, which commit — is a claim about a document nothing here read.
     */
    it("claims the provenance read-back only as far as it looked", () => {
      expect(notes).toContain("at an HTTPS URL");
      expect(notes).toContain("SLSA provenance predicate");
      expect(notes).toContain("read that back from the registry after publishing");
      // And says what it did not do, in the same breath.
      expect(notes).toContain("did not fetch or verify the attestation bundle");
      expect(notes).toContain("did not bind it to this workflow run or commit");
      expect(notes).toContain("`npm audit signatures` against a clean install is a separate check");

      for (const forbidden of [
        "which workflow run",
        "which commit produced it",
        "describes this workflow run",
        "signature was verified",
      ]) {
        expect(notes, forbidden).not.toContain(forbidden);
      }
    });

    it("presents the authentication path as configuration, and declines to infer from it", () => {
      // How the workflow is set up is not evidence about how a given version was published.
      expect(notes).toContain(
        "configured to authenticate through npm Trusted Publishing over OIDC",
      );
      expect(notes).toContain("do not infer the authentication path from that configuration");
      expect(notes).not.toContain("Published with npm Trusted Publishing over OIDC");
    });

    it("narrows the credential claim when the preflight reported nothing", () => {
      expect(unverified).toContain("configured to supply no long-lived npm token");
      expect(unverified).toContain("treat that as unverified");
      expect(unverified).not.toContain("it verified that no npm credential was present");
    });

    it("narrows the provenance claim when no read-back happened", () => {
      expect(unverified).toContain("without a read-back");
      expect(unverified).toContain("unverified here");
      expect(unverified).not.toContain("npm reports provenance attestation metadata");
    });

    it("keeps the authentication mechanism a separate claim from both", () => {
      // One sentence standing for all three is how an unverified claim rides along with a verified
      // one. The mechanism is how the workflow is configured, which the checkout does establish.
      for (const body of [notes, unverified]) {
        expect(body).toContain(
          "configured to authenticate through npm Trusted Publishing over OIDC",
        );
        expect(body).toContain("do not infer the authentication path from that configuration");
      }
      // And never the past-tense form the generator could not support.
      expect(unverified).not.toContain("Published with npm Trusted Publishing over OIDC");
    });

    it("asserts each claim only when its own flag is set", () => {
      const credentialOnly = generateSdkReleaseNotes(inputFrom({}, { credentialPreflight: true }));
      expect(credentialOnly).toContain("it verified that no npm credential was present");
      expect(credentialOnly).toContain("without a read-back");
    });

    it("refuses a non-boolean verified value", () => {
      // A truthy string standing in for a check that ran is exactly the confusion this closes.
      expect(() =>
        generateSdkReleaseNotes(
          inputFrom({}, { credentialPreflight: "yes" as unknown as boolean }),
        ),
      ).toThrow(/must be a boolean/);
    });
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
    // claim about the package; what holds is a claim about this version — and only while this
    // version is a prerelease, which is why the assertion follows the manifest rather than assuming
    // one channel.
    expect(notes).not.toContain(`The package is published on \`${DIST_TAG}\` only.`);
    if (DIST_TAG === "latest") {
      expect(notes).not.toContain("this release does not move");
      return;
    }
    expect(notes).toContain(
      `Version \`${manifest.version}\` is published on \`${DIST_TAG}\`; this release does not move \`latest\`.`,
    );
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

/**
 * Both channels, pinned regardless of what the manifest currently says.
 *
 * Everything above renders the version this checkout would release, which is one channel at a time
 * — so on its own it would leave the other channel's copy unexercised until a release day. These
 * two bodies are generated from fixed versions, so the prerelease copy and the stable copy are both
 * checked on every run.
 *
 * The distinction being pinned is what "beta caveats" used to conflate. Two of those bullets are
 * about the *release channel* and are false of a stable release; the rest describe the SDK and are
 * true of both. A stable release that still carried "the public API is a prerelease" would be the
 * same class of defect as `v0.1.0-beta.1`'s Caveats denying six capabilities the CLI shipped.
 */
describe("SDK release notes — the two channels", () => {
  const bodyFor = (version: string) => {
    const release = resolveSdkRelease(sdkReleaseTag(version));
    return generateSdkReleaseNotes({
      ...BASE,
      version,
      tag: release.tag,
      npmDistTag: release.distTag,
      tarballFilename: `fairux-sdk-${version}.tgz`,
    });
  };

  // An rc rather than a beta, deliberately: `next` is the prerelease channel and not the beta
  // channel, so a body that still calls its release a beta is caught by the word appearing at all.
  const prerelease = bodyFor("0.9.0-rc.7");
  const stable = bodyFor("1.2.3");

  it("gives both channels the same sections", () => {
    for (const body of [prerelease, stable]) {
      const sections = body
        .split("\n")
        .filter((line) => line.startsWith("## "))
        .map((line) => line.slice(3));
      expect(sections).toEqual([...SDK_RELEASE_SECTIONS]);
    }
    // The heading is `Caveats`, not `Beta caveats`: a stable release cannot honestly carry the
    // second, and a section whose name depends on the channel is a section a reader cannot look up.
    expect(SDK_RELEASE_SECTIONS).toContain("Caveats");
    expect(SDK_RELEASE_SECTIONS).not.toContain("Beta caveats");
  });

  it("tells a prerelease reader to name the channel, and a stable reader not to", () => {
    expect(prerelease).toContain("```bash\nnpm install @fairux/sdk@next\n```");
    expect(stable).toContain("```bash\nnpm install @fairux/sdk\n```");
    expect(stable).not.toContain("@fairux/sdk@latest");
  });

  it("carries the channel caveats only on the prerelease", () => {
    for (const claim of [
      "The public API is a prerelease",
      "this release does not move `latest`",
      "opting in stays explicit",
    ]) {
      expect(prerelease, claim).toContain(claim);
      expect(stable, claim).not.toContain(claim);
    }
  });

  it("keeps every product limitation on both", () => {
    // These describe the engine, not the channel. Dropping one from the stable notes would be a
    // Release body quietly claiming a capability the package does not have.
    for (const limitation of [
      "No coverage-aware risk index and no scoring.",
      "No baselines and no suppressions.",
      "No machine-applicable remediation",
      "No AI review.",
      "Third-party RulePacks are not sandboxed.",
    ]) {
      expect(prerelease, limitation).toContain(limitation);
      expect(stable, limitation).toContain(limitation);
    }
  });

  it("never calls a release a beta", () => {
    // The copy used to say it in the overview, the install section, and the caveats heading. An rc
    // is now publishable and would have been described as a beta by every one of them — which is
    // why the prerelease body above is an rc: the word cannot come from its own version string.
    for (const body of [prerelease, stable]) {
      expect(body.toLowerCase()).not.toContain("beta");
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

  // The generator used to refuse every one of these under a beta-only guard, because its copy called
  // the release a beta in the overview, the install section, and the caveats. The copy is
  // conditional now, so the guard is about eligibility: what it still refuses is what the *workflow*
  // refuses.
  it.each(["beta", "0.1", "v1.0.0", "0.0.0-bootstrap.0"])(
    "refuses %s, which is not a release this workflow performs",
    (version) =>
      reject({
        version,
        tag: `sdk-v${version}`,
        tarballFilename: `fairux-sdk-${version}.tgz`,
      }),
  );

  it.each(["0.1.0-beta", "0.1.0-beta.1", "9.9.9-beta.42", "0.1.0-rc.1", "0.1.0-1", "1.0.0"])(
    "accepts %s",
    (version) => {
      const release = resolveSdkRelease(sdkReleaseTag(version));
      expect(() =>
        generateSdkReleaseNotes({
          ...BASE,
          version,
          tag: release.tag,
          npmDistTag: release.distTag,
          tarballFilename: `fairux-sdk-${version}.tgz`,
        }),
      ).not.toThrow();
    },
  );

  it("refuses a dist-tag other than the one this version publishes to", () => {
    // Both directions, because the generator derives the channel rather than accepting it: a
    // prerelease announced on `latest` and a stable release announced on `next` are each an install
    // command nobody can follow.
    reject({ npmDistTag: DIST_TAG === "latest" ? "next" : "latest" });
    reject({ npmDistTag: "bootstrap" });
  });

  it("refuses a tarball name the manifest does not imply", () =>
    reject({ tarballFilename: "fairux-sdk-0.1.0-beta.1.tgz" }));

  it("refuses a checksum file the bundle does not carry", () =>
    reject({ checksumFilename: "sha256.txt" }));

  it("refuses a source commit that is not a full SHA", () => reject({ sourceCommit: "516b247" }));

  it("refuses a missing entry point", () => reject({ publicEntryPoints: ENTRY_POINTS.slice(1) }));

  it("refuses an entry point the notes have no words for", () =>
    reject({ publicEntryPoints: [...ENTRY_POINTS, "@fairux/sdk/internal"] }));

  it("refuses an empty entry-point list", () => reject({ publicEntryPoints: [] }));

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
  it("derives the entry points from the manifest, skipping the tooling export", () => {
    expect(
      sdkPublicEntryPoints({
        name: "@scope/pkg",
        exports: {
          ".": "./dist/index.js",
          "./html": "./dist/html.js",
          "./package.json": "./package.json",
        },
      }),
    ).toEqual(["@scope/pkg", "@scope/pkg/html"]);
  });

  it("derives the same set the manifest's own exports name", () => {
    expect(ENTRY_POINTS).toEqual(
      Object.keys(manifest.exports)
        .filter((subpath) => subpath !== "./package.json")
        .map((subpath) =>
          subpath === "." ? manifest.name : `${manifest.name}${subpath.slice(1)}`,
        ),
    );
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

  it.each([
    "https://github.com/attacker/repository",
    "https://github.com/toshtag/another-repository",
    "git+https://github.com/evil/fairux-linter.git",
  ])("rejects %s, which would redirect documentation links to another repository", (url) => {
    // `repositoryHttpsUrl` proves only the shape `https://github.com/<owner>/<repo>`, and every
    // link in the Documentation section follows whatever it returns. The destination is pinned.
    expect(() => generateSdkReleaseNotes(inputFrom({ repository: { url } }))).toThrow(
      SdkReleaseNotesError,
    );
  });

  it("accepts the repository this package actually declares", () => {
    expect(BASE.repositoryUrl).toBe("https://github.com/toshtag/fairux-linter");
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
      DIST_TAG,
      "--tarball",
      TARBALL_PATH,
      "--checksum",
      SDK_RELEASE_CHECKSUM_FILE,
    ]);
  });

  it("appends a verified flag only when the caller reports that check ran", () => {
    // The dry run passes none: it rehearses the invocation without publishing, so it has verified
    // nothing, and the notes it renders should say so rather than borrow the workflow's results.
    const rehearsal = sdkReleaseNotesInvocation({
      tag: TAG,
      sourceCommit: COMMIT,
      tarball: TARBALL_PATH,
    });
    expect(rehearsal).not.toContain("--verified-credential-preflight");
    expect(rehearsal).not.toContain("--verified-provenance-attested");

    const published = sdkReleaseNotesInvocation({
      tag: TAG,
      sourceCommit: COMMIT,
      tarball: TARBALL_PATH,
      verified: { credentialPreflight: true, provenanceAttested: true },
    });
    expect(published).toContain("--verified-credential-preflight");
    expect(published).toContain("--verified-provenance-attested");
    // Presence-only: a flag takes no value, so nothing can be smuggled in beside it.
    expect(published.filter((arg) => arg.startsWith("--verified-"))).toHaveLength(2);

    const partial = sdkReleaseNotesInvocation({
      tag: TAG,
      sourceCommit: COMMIT,
      tarball: TARBALL_PATH,
      verified: { credentialPreflight: true },
    });
    expect(partial).toContain("--verified-credential-preflight");
    expect(partial).not.toContain("--verified-provenance-attested");
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

describe("SDK release notes — the public READMEs", () => {
  // The Release body links both READMEs, so a determinism claim it has narrowed cannot stay wider
  // in the documents it sends a reader to. This checks that boundary and nothing else about them.
  const sdkReadme = readFileSync(resolve(root, "packages/sdk/README.md"), "utf8");
  const rootReadme = readFileSync(resolve(root, "README.md"), "utf8");

  it("keeps the public READMEs aligned with the built-in determinism boundary", () => {
    for (const [name, source] of [
      ["packages/sdk/README.md", sdkReadme],
      ["README.md", rootReadme],
    ] as const) {
      expect(source, name).toContain("same normalized input and the same scanner policy");
      expect(source, name).not.toContain("deterministic for the same normalized input.");
    }
  });

  it("states the same product boundary in the security boundary", () => {
    // The guarantee used to live in a Product boundary section of `docs/status.md`, which the
    // Release body linked. It is now `## What FairUX guarantees`, beside the refusals it qualifies
    // — the same claims, in the document a reader reaches when asking what FairUX promises.
    // Wrapped prose: compare with line breaks folded, so a reflow is not a failure.
    const boundary = readFileSync(
      resolve(root, "docs/reference/security-boundary.md"),
      "utf8",
    ).replace(/\s+/g, " ");
    expect(boundary).toContain("for the same normalized input under the same scanner policy");
    expect(boundary).toContain("an explanation of why the issue matters");
    expect(boundary).toContain("live on the RulePack rather than in `FairUxReport`");
    expect(boundary).toContain("outside that determinism guarantee");
    expect(boundary).not.toContain("FairUX returns deterministic UX risk signals");
    // The verdict boundary is unchanged.
    expect(boundary).toContain("legal verdicts, fraud verdicts, site safety verdicts");
  });

  it("does not call the package's findings deterministic without qualification", () => {
    // A third-party pack's `evaluate()` may use mutable state, the network, or an AI API — which
    // the same README says two paragraphs later.
    expect(sdkReadme).not.toContain("This package exposes deterministic findings only.");
    expect(sdkReadme).toContain("Third-party rule packs are different");
    expect(sdkReadme).toContain("mutable state");
    expect(rootReadme).not.toContain(
      "normalized UI models, deterministic findings, and RulePack composition",
    );

    // The headline sentences, which are the first thing either reader sees.
    expect(sdkReadme).toContain("Public SDK facade for FairUX scanning and RulePack composition.");
    expect(sdkReadme).not.toContain("Public SDK facade for deterministic FairUX scanning");
    expect(rootReadme).not.toContain("products\nthat need deterministic FairUX findings");
  });
});

describe("SDK release notes — the post-merge runbook", () => {
  // The in-place correction of the published Release is run by a maintainer, not by a runner.
  // `$RUNNER_TEMP` is unset there, so `--out "$RUNNER_TEMP/sdk-release-notes.md"` would have
  // written to `/sdk-release-notes.md`. This pins the scratch directory the section documents; it
  // does not execute the section or check anything else about it.
  const section =
    readFileSync(resolve(root, "docs/maintainers/release-sdk.md"), "utf8")
      .split("## Correcting a published Release")[1]
      ?.split("\n## ")[0] ?? "";

  // Only what the section tells a maintainer to run. The prose around it names the forbidden
  // commands in order to rule them out, so asserting over the whole section would read that
  // explanation as an instruction.
  const commands = [...section.matchAll(/```bash\n([\s\S]*?)```/g)]
    .map((match) => match[1])
    .join("\n");

  it("documents the in-place update", () => {
    expect(section).not.toBe("");
    expect(commands).toContain('gh release edit "$RELEASE_TAG"');
  });

  it("stops on the first failure, by shell contract rather than by prose", () => {
    // "Stop if this fails" in a paragraph is not a stop. A failed `git fetch` would otherwise
    // leave the next command reading whatever the working copy already had.
    expect(commands.trimStart().startsWith("set -euo pipefail")).toBe(true);
  });

  it("names the GitHub host and repository on every read and on the write", () => {
    // `gh` resolves an unqualified command through GH_HOST, GH_REPO, and the current directory's
    // remotes. Pinning npm to the public registry while leaving the write target to the
    // environment would be the wrong way round.
    // Whole commands, not lines: the flag often sits on the next continuation line.
    const ghCalls = commands
      .split("\n")
      .reduce<string[]>((joined, line) => {
        const previous = joined.at(-1);
        if (previous?.endsWith("\\"))
          joined[joined.length - 1] = `${previous.slice(0, -1)} ${line.trim()}`;
        else joined.push(line);
        return joined;
      }, [])
      .filter((line) => line.trimStart().startsWith("gh "));
    expect(ghCalls.length).toBeGreaterThanOrEqual(7);
    for (const call of ghCalls) {
      const pinned = call.includes("--hostname") || call.includes("--repo");
      expect(pinned, call).toBe(true);
    }
    expect(commands).toContain('readonly GITHUB_REPOSITORY="github.com/toshtag/fairux-linter"');
    expect(commands).toContain('--repo "$GITHUB_REPOSITORY"');
  });

  it("writes the notes into a scratch directory it creates and removes", () => {
    expect(commands).toContain("work=$(mktemp -d)");
    expect(commands).toContain(`trap 'rm -rf "$work"' EXIT`);
    expect(commands).toContain('--out "$work/sdk-release-notes.md"');
    expect(commands).toContain('--notes-file "$work/sdk-release-notes.md"');
    // Unset outside Actions: `--out "$RUNNER_TEMP/…"` would have written to the filesystem root.
    expect(commands).not.toContain("RUNNER_TEMP");
  });

  it("verifies the external state before it edits anything", () => {
    // Comparing before against after proves only that nothing changed — a Release already pointing
    // at the wrong commit, or carrying the wrong assets, would pass that and fail nothing.
    const preflight = commands.indexOf('--release "$work/release-before.json"');
    const edit = commands.indexOf("gh release edit");
    expect(preflight).toBeGreaterThanOrEqual(0);
    expect(edit).toBeGreaterThan(preflight);

    expect(commands).toContain('"$GITHUB_API_REPOSITORY/releases/tags/$RELEASE_TAG"');
    expect(commands).toContain('npm view "@fairux/sdk@0.1.0-beta.2" --json');
    expect(commands).toContain("npm view @fairux/sdk dist-tags --json");
    expect(commands).toContain("node scripts/check-sdk-release-state.mjs");
  });

  it("reads npm through the public registry, with a fresh cache per capture", () => {
    // `@fairux/sdk` is scoped: npm resolves it through `@fairux:registry` first, so `--registry`
    // alone leaves a maintainer's npmrc in charge of which host answers. A shared cache would also
    // let the second read return the first read's answer.
    const views = commands.split("\n").filter((line) => line.includes("npm view"));
    expect(views.length).toBeGreaterThanOrEqual(4);
    expect(commands).toContain("--registry=https://registry.npmjs.org/");
    expect(commands).toContain("--@fairux:registry=https://registry.npmjs.org/");
    expect(commands).toContain("--prefer-online");
    // Counted, not merely present: the two captures make two npm reads each, and one of them
    // silently reusing the other's cache would make the second read return the first read's answer.
    const cacheFlags = commands.match(/--cache "\$work\/npm-cache-(before|after)"/g) ?? [];
    expect(cacheFlags.filter((flag) => flag.includes("before"))).toHaveLength(2);
    expect(cacheFlags.filter((flag) => flag.includes("after"))).toHaveLength(2);
  });

  it("re-reads every source afterwards and compares them", () => {
    expect(commands).toContain('--before "$work/release-before.json"');
    expect(commands).toContain('--npm-before "$work/npm-before.json"');
    expect(commands).toContain('--dist-tags-before "$work/dist-tags-before.json"');
    expect(commands).toContain('--tag-ref-before "$work/tag-ref-before.json"');
    expect(commands).toContain('--tag-object-before "$work/tag-object-before.json"');
    expect(commands).toContain('--body "$work/sdk-release-notes.md"');
  });

  it("describes the comparison as what it is, not as a byte comparison", () => {
    // The capture has been through `JSON.parse`; the comparison is over decoded strings, and the
    // lengths reported are UTF-16 code units. "Byte-for-byte" claims a stronger thing than runs.
    expect(section).toContain("exact source-text equality after folding CRLF to LF");
    expect(section).not.toContain("byte-for-byte");
    expect(section).not.toContain("source bytes");
    // The same document said both things: this one survived the first correction.
    expect(section).not.toContain("is a byte comparison over the GitHub API");
    // The projection is a listed set, not every field GitHub returns.
    expect(section).toContain("The projection is a listed set, not everything GitHub returns");
    expect(section).not.toContain("every immutable field");
  });

  it("separates what the automated evidence establishes from what it does not", () => {
    // "What the update is allowed to change is name, body, and updated_at" asserted that fields
    // the check never compares were unchanged. Intent and evidence are different claims.
    expect(section).toContain(
      "The automated evidence establishes the corrected presentation and the enumerated",
    );
    expect(section).toContain("It does not establish unlisted GitHub API fields.");
    expect(section).not.toContain("What the update is allowed to change is");
  });

  it("keeps the rendering check manual, and says so", () => {
    expect(section).toContain("### Manual presentation check");
    expect(section).toContain("Record it as manual presentation evidence with the observer");
    expect(section).toContain("is not a machine assertion");
  });

  it("dereferences the annotated tag rather than reading the ref's own sha", () => {
    // The ref names a tag object; only its dereference names a commit.
    expect(commands).toContain('"$GITHUB_API_REPOSITORY/git/ref/tags/$RELEASE_TAG"');
    expect(commands).toContain('"$GITHUB_API_REPOSITORY/git/tags/$tag_object"');
  });

  it("describes the old Release from the manifest that shipped with it", () => {
    // The notes state a description, Node engines, entry points, and a repository URL. Reading
    // those from the current `main` while pinning `--source-commit` to the Release's target would
    // describe an old artifact with today's contract. The two manifests happen to agree now; this
    // does not rely on that.
    // Read out of the state just verified, rather than retyped: a hardcoded SHA that disagreed
    // with the live Release would otherwise go unnoticed.
    //
    // The target comes from the tag, not from `target_commitish` — that field holds `main`, so
    // resolving through it would read exactly the manifest this step must not use. The prose has
    // to make the same distinction the commands do; "the existing Release target" named neither.
    expect(section).toContain("come from the commit resolved from the\nexisting Release tag");
    expect(section).toContain("not from the Release API's `target_commitish` branch");
    expect(section).not.toContain("come from the existing Release target");
    // Fetched from the official HTTPS repository, not from whatever `origin` happens to be, and
    // not from a local tag that may be stale. The fetched commit, the commit GitHub's tag ref
    // dereferences to, and the expected constant must all agree before anything is read from it.
    expect(commands).toContain('"https://$GITHUB_REPOSITORY.git" \\');
    expect(commands).toContain('release_target=$(git rev-parse "FETCH_HEAD^{commit}")');
    expect(commands).toContain('[ "$release_target" != "$verified_commit" ]');
    expect(commands).toContain('[ "$release_target" != "$RELEASE_COMMIT" ]');
    expect(commands).not.toContain("git fetch origin --tags");
    expect(commands).not.toContain("jq -r '.target_commitish'");
    expect(commands).toContain('git show "$release_target:packages/sdk/package.json"');
    expect(commands).toContain('> "$work/package.json"');
    expect(commands).toContain('--package-json "$work/package.json"');
    expect(commands).toContain('--source-commit "$release_target"');
    expect(commands).not.toContain("--package-json packages/sdk/package.json");
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
    DIST_TAG,
    "--tarball",
    // An absolute path, as the workflow passes it: the notes name the file, not the runner's path.
    `/tmp/bundle/${TARBALL}`,
    "--checksum",
    `/tmp/bundle/${SDK_RELEASE_CHECKSUM_FILE}`,
    // The two flags the privileged job passes when its preflight and provenance read-back ran, so
    // this CLI output is comparable with `notes` above rather than being a narrower document.
    "--verified-credential-preflight",
    "--verified-provenance-attested",
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
