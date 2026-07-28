import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  compareSdkReleaseBody,
  compareSdkReleaseStates,
  EXPECTED_SDK_RELEASE_STATE,
  EXPECTED_SDK_RELEASE_TITLE,
  EXPECTED_SDK_TAG_REF,
  immutableSdkReleaseProjection,
  immutableSdkTagProjection,
  validateCorrectedSdkReleasePresentation,
  validateExpectedSdkReleaseState,
  validateExpectedSdkTagRef,
} from "../../../scripts/check-sdk-release-state.mjs";

/**
 * The gate in front of an edit to something already published, exercised by the shapes that must
 * not pass it.
 *
 * The first version of this checker failed open. Given a capture whose assets carried only names,
 * whose npm `dist` was `{}`, and whose `latest` pointed at `evil-version`, it printed three ticks
 * and exited 0: every identity it claimed to compare was `undefined` on both sides. Each of those
 * fixtures is a case here, so the check cannot quietly return to comparing absences.
 */

const root = resolve(import.meta.dirname, "../../..");
const checker = resolve(root, "scripts/check-sdk-release-state.mjs");

const release = () => ({
  tag_name: EXPECTED_SDK_RELEASE_STATE.tag,
  target_commitish: EXPECTED_SDK_RELEASE_STATE.targetCommitish,
  prerelease: true,
  draft: false,
  name: "@fairux/sdk 0.1.0-beta.2",
  body: "notes\n",
  assets: EXPECTED_SDK_RELEASE_STATE.assets.map((asset) => ({ ...asset })),
});

const npmMetadata = () => ({
  version: EXPECTED_SDK_RELEASE_STATE.npm.version,
  dist: {
    shasum: EXPECTED_SDK_RELEASE_STATE.npm.shasum,
    integrity: EXPECTED_SDK_RELEASE_STATE.npm.integrity,
    tarball: EXPECTED_SDK_RELEASE_STATE.npm.tarball,
    fileCount: EXPECTED_SDK_RELEASE_STATE.npm.fileCount,
    unpackedSize: EXPECTED_SDK_RELEASE_STATE.npm.unpackedSize,
  },
});

const distTags = () => ({ ...EXPECTED_SDK_RELEASE_STATE.distTags });

const validate = (overrides: { release?: unknown; npmMetadata?: unknown; distTags?: unknown }) =>
  validateExpectedSdkReleaseState({
    release: "release" in overrides ? overrides.release : release(),
    npmMetadata: "npmMetadata" in overrides ? overrides.npmMetadata : npmMetadata(),
    distTags: "distTags" in overrides ? overrides.distTags : distTags(),
  });

describe("SDK Release state — the recorded state passes", () => {
  it("accepts the state this Release actually holds", () => {
    expect(validate({})).toEqual([]);
  });

  it("matches what the tag resolves to, which is not target_commitish", () => {
    // `target_commitish` is `main`, a branch name. Deriving the release target from it would read
    // whatever `main` holds today — the drift the correction procedure exists to avoid.
    expect(EXPECTED_SDK_RELEASE_STATE.targetCommitish).toBe("main");
    expect(EXPECTED_SDK_RELEASE_STATE.tagCommit).toMatch(/^[0-9a-f]{40}$/);
    expect(EXPECTED_SDK_RELEASE_STATE.tagCommit).not.toBe(
      EXPECTED_SDK_RELEASE_STATE.targetCommitish,
    );
  });
});

describe("SDK Release state — the fixtures that used to pass", () => {
  it("refuses assets that carry only names", () => {
    const capture = release();
    capture.assets = EXPECTED_SDK_RELEASE_STATE.assets.map((asset) => ({
      name: asset.name,
    })) as never;
    const failures = validate({ release: capture });

    expect(failures).not.toEqual([]);
    for (const field of ["id", "size", "digest", "content_type"]) {
      expect(failures.join("\n")).toContain(field);
    }
  });

  it("refuses an empty npm dist", () => {
    const failures = validate({ npmMetadata: { version: "0.1.0-beta.2", dist: {} } });
    expect(failures.join("\n")).toContain("shasum");
    expect(failures.join("\n")).toContain("integrity");
    expect(failures.join("\n")).toContain("fileCount");
    expect(failures.join("\n")).toContain("unpackedSize");
  });

  it("refuses a latest dist-tag pointing anywhere else", () => {
    expect(validate({ distTags: { ...distTags(), latest: "evil-version" } })).not.toEqual([]);
  });

  it("refuses a dist-tag channel nobody decided to add", () => {
    const failures = validate({ distTags: { ...distTags(), canary: "9.9.9" } });
    expect(failures.join("\n")).toContain("canary");
  });
});

describe("SDK Release state — the Release itself", () => {
  it.each([
    ["tag_name", { tag_name: "sdk-v0.1.0-beta.3" }],
    ["target_commitish", { target_commitish: "release" }],
    ["prerelease", { prerelease: false }],
    ["draft", { draft: true }],
  ])("refuses a changed %s", (_field, override) => {
    expect(validate({ release: { ...release(), ...override } })).not.toEqual([]);
  });

  it("refuses a missing asset", () => {
    const capture = release();
    capture.assets = [capture.assets[0] as never];
    expect(validate({ release: capture }).join("\n")).toContain("release-sha256.txt is missing");
  });

  it("refuses an extra asset", () => {
    const capture = release();
    capture.assets = [
      ...capture.assets,
      { id: 1, name: "extra.txt", size: 1, digest: "sha256:aa", content_type: "text/plain" },
    ] as never;
    expect(validate({ release: capture }).join("\n")).toContain("unexpected asset");
  });

  it("refuses two assets with the same name", () => {
    const capture = release();
    capture.assets = [capture.assets[0], capture.assets[0]] as never;
    expect(validate({ release: capture }).join("\n")).toContain("duplicate asset names");
  });

  it.each(["id", "size", "digest", "content_type"])("refuses an asset missing its %s", (field) => {
    const capture = release();
    const asset = { ...(capture.assets[0] as Record<string, unknown>) };
    delete asset[field];
    capture.assets = [asset, capture.assets[1]] as never;
    expect(validate({ release: capture }).join("\n")).toContain(field);
  });

  it("refuses a null asset digest rather than treating it as unchanged", () => {
    const capture = release();
    capture.assets = [
      { ...(capture.assets[0] as Record<string, unknown>), digest: null },
      capture.assets[1],
    ] as never;
    expect(validate({ release: capture }).join("\n")).toContain("digest");
  });

  it.each(["id", "size", "digest", "content_type"])("refuses a changed asset %s", (field) => {
    const capture = release();
    const changed: Record<string, unknown> = { ...(capture.assets[0] as Record<string, unknown>) };
    changed[field] = field === "id" || field === "size" ? 999 : "different";
    capture.assets = [changed, capture.assets[1]] as never;
    expect(validate({ release: capture })).not.toEqual([]);
  });
});

describe("SDK Release state — npm metadata", () => {
  it.each(["shasum", "integrity", "tarball", "fileCount", "unpackedSize"])(
    "refuses a missing dist.%s",
    (field) => {
      const capture = npmMetadata();
      delete (capture.dist as Record<string, unknown>)[field];
      expect(validate({ npmMetadata: capture }).join("\n")).toContain(field);
    },
  );

  it.each([
    ["version", "0.1.0-beta.3"],
    ["shasum", "0000000000000000000000000000000000000000"],
    ["integrity", "sha512-different"],
    ["tarball", "https://registry.npmjs.org/@fairux/sdk/-/sdk-9.9.9.tgz"],
    ["fileCount", 15],
    ["unpackedSize", 451769],
  ])("refuses a changed %s", (field, value) => {
    const capture = npmMetadata() as Record<string, unknown> & { dist: Record<string, unknown> };
    if (field === "version") capture.version = value;
    else capture.dist[field] = value;
    expect(validate({ npmMetadata: capture })).not.toEqual([]);
  });

  it("refuses a shasum that is not 40 hex characters", () => {
    const capture = npmMetadata();
    capture.dist.shasum = "f89bb1c9";
    expect(validate({ npmMetadata: capture }).join("\n")).toContain("40 hex");
  });

  it("refuses a tarball served over plain HTTP", () => {
    const capture = npmMetadata();
    capture.dist.tarball = "http://registry.npmjs.org/@fairux/sdk/-/sdk-0.1.0-beta.2.tgz";
    expect(validate({ npmMetadata: capture }).join("\n")).toContain("HTTPS");
  });
});

describe("SDK Release state — dist-tags", () => {
  it.each(["next", "latest", "bootstrap"])("refuses a missing %s", (tag) => {
    const capture = distTags() as Record<string, string>;
    delete capture[tag];
    expect(validate({ distTags: capture }).join("\n")).toContain(tag);
  });

  it.each([
    ["next", "0.1.0-beta.3"],
    ["latest", "0.1.0-beta.2"],
    ["bootstrap", "0.1.0-beta.2"],
  ])("refuses a changed %s", (tag, version) => {
    expect(validate({ distTags: { ...distTags(), [tag]: version } })).not.toEqual([]);
  });

  it.each([null, [], "next=0.1.0-beta.2"])("refuses %j, which is not a dist-tag map", (capture) => {
    expect(validate({ distTags: capture }).join("\n")).toContain("not a JSON object");
  });
});

describe("SDK Release state — the before/after comparison", () => {
  const project = () =>
    immutableSdkReleaseProjection({
      release: release(),
      npmMetadata: npmMetadata(),
      distTags: distTags(),
    });

  it("passes when nothing immutable moved", () => {
    expect(compareSdkReleaseStates(project(), project())).toEqual([]);
  });

  it("passes when only the name, body, and timestamp differ", () => {
    const after = immutableSdkReleaseProjection({
      release: { ...release(), name: "new title", body: "new body\n", updated_at: "later" },
      npmMetadata: npmMetadata(),
      distTags: distTags(),
    });
    expect(compareSdkReleaseStates(project(), after)).toEqual([]);
  });

  it.each([
    ["asset id", (r: ReturnType<typeof release>) => ((r.assets[0] as { id: number }).id = 1)],
    ["asset size", (r: ReturnType<typeof release>) => ((r.assets[0] as { size: number }).size = 1)],
    [
      "asset digest",
      (r: ReturnType<typeof release>) => ((r.assets[0] as { digest: string }).digest = "sha256:zz"),
    ],
    [
      "content_type",
      (r: ReturnType<typeof release>) =>
        ((r.assets[0] as { content_type: string }).content_type = "text/plain"),
    ],
  ])("reports a changed %s", (_label, mutate) => {
    const after = release();
    mutate(after);
    expect(
      compareSdkReleaseStates(
        project(),
        immutableSdkReleaseProjection({
          release: after,
          npmMetadata: npmMetadata(),
          distTags: distTags(),
        }),
      ),
    ).not.toEqual([]);
  });

  it.each([
    ["integrity", "sha512-other"],
    ["fileCount", 15],
  ])("reports a changed npm %s", (field, value) => {
    const after = npmMetadata() as { dist: Record<string, unknown> };
    after.dist[field] = value;
    expect(
      compareSdkReleaseStates(
        project(),
        immutableSdkReleaseProjection({
          release: release(),
          npmMetadata: after,
          distTags: distTags(),
        }),
      ),
    ).not.toEqual([]);
  });

  it("reports a changed dist-tag", () => {
    expect(
      compareSdkReleaseStates(
        project(),
        immutableSdkReleaseProjection({
          release: release(),
          npmMetadata: npmMetadata(),
          distTags: { ...distTags(), latest: "0.1.0-beta.2" },
        }),
      ),
    ).not.toEqual([]);
  });
});

describe("SDK Release state — the body comparison", () => {
  it("accepts a CRLF body against an LF file", () => {
    expect(compareSdkReleaseBody("## Overview\r\n\r\ntext\r\n", "## Overview\n\ntext\n")).toEqual(
      [],
    );
  });

  it("refuses a standalone carriage return rather than stripping it", () => {
    // `replaceAll("\r", "")` made `ab\rc\n` equal `abc\n`.
    expect(compareSdkReleaseBody("ab\rc\n", "abc\n").join("")).toContain("standalone carriage");
  });

  it.each([
    ["a missing trailing newline", "abc", "abc\n"],
    ["an extra trailing newline", "abc\n\n", "abc\n"],
    ["extra whitespace", "abc \n", "abc\n"],
    ["different text", "abd\n", "abc\n"],
  ])("refuses %s", (_label, published, generated) => {
    expect(compareSdkReleaseBody(published, generated)).not.toEqual([]);
  });

  it("refuses a body that is not a string", () => {
    expect(compareSdkReleaseBody(undefined, "abc\n").join("")).toContain("missing");
  });
});

describe("SDK Release state — the CLI", () => {
  const write = (contents: Record<string, unknown>, name: string, dir: string) => {
    const path = join(dir, name);
    writeFileSync(path, JSON.stringify(contents), "utf8");
    return path;
  };

  const run = (args: string[]): number => {
    try {
      execFileSync(process.execPath, [checker, ...args], { stdio: "pipe" });
      return 0;
    } catch (error) {
      return (error as { status?: number }).status ?? -1;
    }
  };

  it("runs nothing when imported", () => {
    const output = execFileSync(
      process.execPath,
      ["--input-type=module", "-e", `await import(${JSON.stringify(`file://${checker}`)});`],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    expect(output).toBe("");
  });

  it("exits 0 on the recorded state, and 1 once any of it is missing", () => {
    const dir = mkdtempSync(join(tmpdir(), "fairux-release-state-"));
    const tagRef = {
      ref: EXPECTED_SDK_TAG_REF.ref,
      object: { type: EXPECTED_SDK_TAG_REF.objectType, sha: EXPECTED_SDK_TAG_REF.tagObject },
    };
    const tagObject = {
      tag: EXPECTED_SDK_RELEASE_STATE.tag,
      object: { type: "commit", sha: EXPECTED_SDK_RELEASE_STATE.tagCommit },
    };
    const good = [
      "--release",
      write(release(), "release.json", dir),
      "--npm",
      write(npmMetadata(), "npm.json", dir),
      "--dist-tags",
      write(distTags(), "tags.json", dir),
      "--tag-ref",
      write(tagRef, "tag-ref.json", dir),
      "--tag-object",
      write(tagObject, "tag-object.json", dir),
    ];
    expect(run(good)).toBe(0);

    const hollow = release();
    hollow.assets = EXPECTED_SDK_RELEASE_STATE.assets.map((a) => ({ name: a.name })) as never;
    expect(
      run([
        "--release",
        write(hollow, "hollow.json", dir),
        "--npm",
        write({ version: "0.1.0-beta.2", dist: {} }, "hollow-npm.json", dir),
        "--dist-tags",
        write({ ...distTags(), canary: "9.9.9" }, "hollow-tags.json", dir),
        "--tag-ref",
        write(tagRef, "tag-ref.json", dir),
        "--tag-object",
        write(tagObject, "tag-object.json", dir),
      ]),
    ).toBe(1);

    // The gate the presentation check closes: everything immutable intact, the body correct, and
    // the title still the old duplicated-`v` one. Every other check passes; only this catches it.
    const body = join(dir, "body.md");
    writeFileSync(body, "notes\n", "utf8");
    expect(run([...good, "--body", body])).toBe(0);
    expect(
      run([
        ...good.map((argument, index) =>
          good[index - 1] === "--release"
            ? write({ ...release(), name: "@fairux/sdk v0.1.0-beta.2" }, "stale-title.json", dir)
            : argument,
        ),
        "--body",
        body,
      ]),
    ).toBe(1);
  });

  it("exits 2 when a required argument is missing", () => {
    expect(run([])).toBe(2);
  });
});

describe("SDK Release state — the corrected presentation", () => {
  // The immutable projection excludes `name` and `body` on purpose — they are what the edit
  // changes. Nothing checked them, so a Release left with the old duplicated-`v` title and the
  // right body passed every check this file had.
  const generated = "notes\n";

  it("accepts the intended title and body", () => {
    expect(
      validateCorrectedSdkReleasePresentation({
        release: { ...release(), name: EXPECTED_SDK_RELEASE_TITLE, body: generated },
        generatedBody: generated,
      }),
    ).toEqual([]);
  });

  it("refuses the old duplicated-v title", () => {
    const failures = validateCorrectedSdkReleasePresentation({
      release: { ...release(), name: "@fairux/sdk v0.1.0-beta.2", body: generated },
      generatedBody: generated,
    });
    expect(failures.join("")).toContain("Release title is");
  });

  it.each(["WRONG TITLE", "", undefined])("refuses the title %j", (name) => {
    expect(
      validateCorrectedSdkReleasePresentation({
        release: { ...release(), name, body: generated },
        generatedBody: generated,
      }),
    ).not.toEqual([]);
  });

  it("refuses a right body under a wrong title, and a right title over a wrong body", () => {
    expect(
      validateCorrectedSdkReleasePresentation({
        release: { ...release(), name: "WRONG", body: generated },
        generatedBody: generated,
      }),
    ).not.toEqual([]);
    expect(
      validateCorrectedSdkReleasePresentation({
        release: { ...release(), name: EXPECTED_SDK_RELEASE_TITLE, body: "different\n" },
        generatedBody: generated,
      }),
    ).not.toEqual([]);
  });

  it("uses the same title the runbook passes to gh release edit", () => {
    const runbook = readFileSync(resolve(root, "docs/sdk-beta-release.md"), "utf8");
    expect(runbook).toContain(`readonly RELEASE_TITLE='${EXPECTED_SDK_RELEASE_TITLE}'`);
  });
});

describe("SDK Release state — the tag GitHub holds", () => {
  const tagRef = () => ({
    ref: EXPECTED_SDK_TAG_REF.ref,
    object: { type: EXPECTED_SDK_TAG_REF.objectType, sha: EXPECTED_SDK_TAG_REF.tagObject },
  });
  const tagObject = () => ({
    tag: "sdk-v0.1.0-beta.2",
    object: { type: "commit", sha: EXPECTED_SDK_RELEASE_STATE.tagCommit },
  });

  it("accepts the tag as github.com returns it", () => {
    expect(validateExpectedSdkTagRef({ ref: tagRef(), tagObject: tagObject() })).toEqual([]);
  });

  it("requires the annotated tag to be dereferenced", () => {
    // The ref names a tag object, not a commit. Reading `object.sha` from it alone would compare a
    // tag object against a commit SHA.
    expect(EXPECTED_SDK_TAG_REF.tagObject).not.toBe(EXPECTED_SDK_RELEASE_STATE.tagCommit);
    expect(validateExpectedSdkTagRef({ ref: tagRef(), tagObject: undefined }).join("")).toContain(
      "must be dereferenced",
    );
  });

  it.each([
    ["a different ref", { ref: "refs/tags/sdk-v0.1.0-beta.3" }],
    [
      "a lightweight ref where an annotated one is expected",
      { object: { type: "commit", sha: EXPECTED_SDK_TAG_REF.tagObject } },
    ],
    ["a different tag object", { object: { type: "tag", sha: "0".repeat(40) } }],
  ])("refuses %s", (_label, override) => {
    expect(
      validateExpectedSdkTagRef({ ref: { ...tagRef(), ...override }, tagObject: tagObject() }),
    ).not.toEqual([]);
  });

  it("refuses a tag that resolves to another commit", () => {
    const failures = validateExpectedSdkTagRef({
      ref: tagRef(),
      tagObject: { tag: "sdk-v0.1.0-beta.2", object: { type: "commit", sha: "a".repeat(40) } },
    });
    expect(failures.join("")).toContain("tag resolves to");
  });

  it("reports a tag that moved between the two captures", () => {
    const before = immutableSdkTagProjection({ ref: tagRef(), tagObject: tagObject() });
    const after = immutableSdkTagProjection({
      ref: tagRef(),
      tagObject: { tag: "sdk-v0.1.0-beta.2", object: { type: "commit", sha: "b".repeat(40) } },
    });
    expect(compareSdkReleaseStates(before, after)).not.toEqual([]);
    expect(compareSdkReleaseStates(before, before)).toEqual([]);
  });
});

describe("SDK Release state — recorded constants stay aligned with the runbook", () => {
  // This reads checked-in files. It does not query GitHub or npm, so it establishes internal
  // agreement between the constants and the procedure — not that either matches live state.
  const runbook = readFileSync(resolve(root, "docs/sdk-beta-release.md"), "utf8");

  it("names the same release commit as the runbook", () => {
    expect(runbook).toContain(`readonly RELEASE_COMMIT="${EXPECTED_SDK_RELEASE_STATE.tagCommit}"`);
  });

  it("names the same tag as the runbook", () => {
    expect(runbook).toContain(`readonly RELEASE_TAG="${EXPECTED_SDK_RELEASE_STATE.tag}"`);
  });
});
