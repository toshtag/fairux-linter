import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { SdkReleaseStateContract } from "../../../scripts/check-sdk-release-state.d.mts";
import {
  compareSdkReleaseBody,
  compareSdkReleaseStates,
  immutableSdkReleaseProjection,
  immutableSdkTagProjection,
  validateCorrectedSdkReleasePresentation,
  validateExpectedSdkReleaseState,
  validateExpectedSdkTagRef,
  validateSdkReleaseExpectation,
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

/**
 * One release's expectation, as a fixture rather than as the module's own constant.
 *
 * These are the real `sdk-v0.1.0-beta.2` values, and they are here because a checker that carried
 * them could only ever guard that one release. Deriving the fixtures from the constant under test
 * was also half-circular: it proved the comparison agreed with itself.
 */
const EXPECTED: SdkReleaseStateContract = Object.freeze({
  tag: "sdk-v0.1.0-beta.2",
  targetCommitish: "main",
  tagCommit: "516b2473a7adaa24dd250ec20f916cf53bd9fa28",
  tagRefObject: "35cdf68278afb864a1e01ebdc4250ba197c5f797",
  title: "@fairux/sdk 0.1.0-beta.2",
  prerelease: true,
  draft: false,
  assets: Object.freeze([
    Object.freeze({
      id: 492038157,
      name: "fairux-sdk-0.1.0-beta.2.tgz",
      size: 109595,
      digest: "sha256:5f6c5cf56948429df224f0225301ae1c680a94904743d9788228e92a8287cdd8",
      content_type: "application/x-gtar",
    }),
    Object.freeze({
      id: 492038155,
      name: "release-sha256.txt",
      size: 94,
      digest: "sha256:78be417f756a17ca58bdf6b2281ea9541e0651c96270a62252598f81f02e83e2",
      content_type: "text/plain; charset=utf-8",
    }),
  ]),
  npm: Object.freeze({
    version: "0.1.0-beta.2",
    shasum: "f89bb1c9165c9d16397534c33746e9edc8ee4bf4",
    integrity:
      "sha512-yKVdIS5YJORayBq7vcdbMJklWVNms2OFmF9ujZGUKn503V45UevxLorzEHmV2DDICu6LHvYsoao5qu4P9ltp9g==",
    tarball: "https://registry.npmjs.org/@fairux/sdk/-/sdk-0.1.0-beta.2.tgz",
    fileCount: 14,
    unpackedSize: 451768,
  }),
  distTags: Object.freeze({
    next: "0.1.0-beta.2",
    latest: "0.0.0-bootstrap.0",
    bootstrap: "0.0.0-bootstrap.0",
  }),
});

const EXPECTED_REF = `refs/tags/${EXPECTED.tag}`;

const release = () => ({
  tag_name: EXPECTED.tag,
  target_commitish: EXPECTED.targetCommitish,
  prerelease: true,
  draft: false,
  name: "@fairux/sdk 0.1.0-beta.2",
  body: "notes\n",
  assets: EXPECTED.assets.map((asset) => ({ ...asset })),
});

const npmMetadata = () => ({
  version: EXPECTED.npm.version,
  dist: {
    shasum: EXPECTED.npm.shasum,
    integrity: EXPECTED.npm.integrity,
    tarball: EXPECTED.npm.tarball,
    fileCount: EXPECTED.npm.fileCount,
    unpackedSize: EXPECTED.npm.unpackedSize,
  },
});

const distTags = () => ({ ...EXPECTED.distTags });

const validate = (overrides: { release?: unknown; npmMetadata?: unknown; distTags?: unknown }) =>
  validateExpectedSdkReleaseState(
    {
      release: "release" in overrides ? overrides.release : release(),
      npmMetadata: "npmMetadata" in overrides ? overrides.npmMetadata : npmMetadata(),
      distTags: "distTags" in overrides ? overrides.distTags : distTags(),
    },
    EXPECTED,
  );

describe("the expectation is input now, so it is checked like input", () => {
  // Moving the expected state out of this module reopened the exact hole the file was written to
  // close. A comparison against `{}` agrees on every field it does not have, and the run that
  // reported it would print a tick.
  it("accepts the expectation this fixture describes", () => {
    expect(validateSdkReleaseExpectation(EXPECTED)).toEqual([]);
  });

  it("refuses anything that is not an object", () => {
    for (const value of [undefined, null, [], "sdk-v0.1.0-beta.2", 0]) {
      expect(validateSdkReleaseExpectation(value), String(value)).not.toEqual([]);
    }
  });

  it("refuses an empty expectation rather than agreeing with everything", () => {
    const failures = validateSdkReleaseExpectation({});
    // Every required field, not just the first — a gate that reveals one problem per run invites
    // fixing them one at a time.
    for (const field of ["tag", "targetCommitish", "tagCommit", "title", "tagRefObject"]) {
      expect(failures.join("\n"), field).toContain(field);
    }
    expect(failures.join("\n")).toContain("assets");
    expect(failures.join("\n")).toContain("npm");
    expect(failures.join("\n")).toContain("distTags");
  });

  it("refuses each field individually, so no single omission slips through", () => {
    const omissions: Array<[string, unknown]> = [
      ["tag", { ...EXPECTED, tag: "" }],
      ["targetCommitish", { ...EXPECTED, targetCommitish: undefined }],
      ["tagCommit", { ...EXPECTED, tagCommit: null }],
      ["title", { ...EXPECTED, title: "" }],
      ["tagRefObject", { ...EXPECTED, tagRefObject: undefined }],
      ["prerelease", { ...EXPECTED, prerelease: "true" }],
      ["draft", { ...EXPECTED, draft: undefined }],
      ["assets", { ...EXPECTED, assets: [] }],
      ["asset id", { ...EXPECTED, assets: [{ ...EXPECTED.assets[0], id: undefined }] }],
      ["asset digest", { ...EXPECTED, assets: [{ ...EXPECTED.assets[0], digest: "" }] }],
      ["npm", { ...EXPECTED, npm: {} }],
      ["npm fileCount", { ...EXPECTED, npm: { ...EXPECTED.npm, fileCount: 0 } }],
      ["distTags", { ...EXPECTED, distTags: {} }],
      ["distTags value", { ...EXPECTED, distTags: { next: "" } }],
    ];
    for (const [label, expectation] of omissions) {
      expect(validateSdkReleaseExpectation(expectation), label).not.toEqual([]);
    }
  });

  it("stops the CLI before it compares anything, and says what to do", () => {
    const dir = mkdtempSync(join(tmpdir(), "fairux-release-expectation-"));
    const write = (contents: unknown, name: string) => {
      const path = join(dir, name);
      writeFileSync(path, JSON.stringify(contents), "utf8");
      return path;
    };
    const result = spawnSync(
      process.execPath,
      [
        checker,
        "--expected",
        write({ tag: "sdk-v0.1.0-beta.2" }, "half.json"),
        "--release",
        write(release(), "release.json"),
        "--npm",
        write(npmMetadata(), "npm.json"),
        "--dist-tags",
        write(distTags(), "tags.json"),
        "--tag-ref",
        write(
          { ref: EXPECTED_REF, object: { type: "tag", sha: EXPECTED.tagRefObject } },
          "tr.json",
        ),
        "--tag-object",
        write(
          {
            tag: EXPECTED.tag,
            sha: EXPECTED.tagRefObject,
            object: { type: "commit", sha: EXPECTED.tagCommit },
          },
          "to.json",
        ),
      ],
      { encoding: "utf8" },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("the expected-state file is not usable");
    expect(result.stderr).toContain("before you edit anything");
    // Not one tick: nothing was compared, so nothing may be reported as matching.
    expect(result.stdout).toBe("");
  });
});

describe("SDK Release state — the recorded state passes", () => {
  it("accepts the state this Release actually holds", () => {
    expect(validate({})).toEqual([]);
  });

  it("matches what the tag resolves to, which is not target_commitish", () => {
    // `target_commitish` is `main`, a branch name. Deriving the release target from it would read
    // whatever `main` holds today — the drift the correction procedure exists to avoid.
    expect(EXPECTED.targetCommitish).toBe("main");
    expect(EXPECTED.tagCommit).toMatch(/^[0-9a-f]{40}$/);
    expect(EXPECTED.tagCommit).not.toBe(EXPECTED.targetCommitish);
  });
});

describe("SDK Release state — the fixtures that used to pass", () => {
  it("refuses assets that carry only names", () => {
    const capture = release();
    capture.assets = EXPECTED.assets.map((asset) => ({
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
      ref: EXPECTED_REF,
      object: { type: "tag", sha: EXPECTED.tagRefObject },
    };
    const tagObject = {
      tag: EXPECTED.tag,
      sha: EXPECTED.tagRefObject,
      object: { type: "commit", sha: EXPECTED.tagCommit },
    };
    const expectedPath = write(EXPECTED, "expected.json", dir);
    const good = [
      "--expected",
      expectedPath,
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
    hollow.assets = EXPECTED.assets.map((a) => ({ name: a.name })) as never;
    expect(
      run([
        "--expected",
        expectedPath,
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

    // A tag object capture missing its own identity, through the CLI.
    expect(
      run(
        good.map((argument, index) =>
          good[index - 1] === "--tag-object"
            ? write({ object: tagObject.object }, "hollow-tag-object.json", dir)
            : argument,
        ),
      ),
    ).toBe(1);
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
      validateCorrectedSdkReleasePresentation(
        {
          release: { ...release(), name: EXPECTED.title, body: generated },
          generatedBody: generated,
        },
        EXPECTED.title,
      ),
    ).toEqual([]);
  });

  it("refuses the old duplicated-v title", () => {
    const failures = validateCorrectedSdkReleasePresentation(
      {
        release: { ...release(), name: "@fairux/sdk v0.1.0-beta.2", body: generated },
        generatedBody: generated,
      },
      EXPECTED.title,
    );
    expect(failures.join("")).toContain("Release title is");
  });

  it.each(["WRONG TITLE", "", undefined])("refuses the title %j", (name) => {
    expect(
      validateCorrectedSdkReleasePresentation(
        {
          release: { ...release(), name, body: generated },
          generatedBody: generated,
        },
        EXPECTED.title,
      ),
    ).not.toEqual([]);
  });

  it("refuses a right body under a wrong title, and a right title over a wrong body", () => {
    expect(
      validateCorrectedSdkReleasePresentation(
        {
          release: { ...release(), name: "WRONG", body: generated },
          generatedBody: generated,
        },
        EXPECTED.title,
      ),
    ).not.toEqual([]);
    expect(
      validateCorrectedSdkReleasePresentation(
        {
          release: { ...release(), name: EXPECTED.title, body: "different\n" },
          generatedBody: generated,
        },
        EXPECTED.title,
      ),
    ).not.toEqual([]);
  });

  it("uses the same title the runbook passes to gh release edit", () => {
    const runbook = readFileSync(resolve(root, "docs/maintainers/release-sdk.md"), "utf8");
    expect(runbook).toContain(`readonly RELEASE_TITLE='${EXPECTED.title}'`);
  });
});

describe("SDK Release state — the tag GitHub holds", () => {
  const tagRef = () => ({
    ref: EXPECTED_REF,
    object: { type: "tag", sha: EXPECTED.tagRefObject },
  });
  const tagObject = () => ({
    tag: EXPECTED.tag,
    sha: EXPECTED.tagRefObject,
    object: { type: "commit", sha: EXPECTED.tagCommit },
  });

  it("accepts the tag as github.com returns it", () => {
    expect(validateExpectedSdkTagRef({ ref: tagRef(), tagObject: tagObject() }, EXPECTED)).toEqual(
      [],
    );
  });

  it("requires the annotated tag to be dereferenced", () => {
    // The ref names a tag object, not a commit. Reading `object.sha` from it alone would compare a
    // tag object against a commit SHA.
    expect(EXPECTED.tagRefObject).not.toBe(EXPECTED.tagCommit);
    expect(
      validateExpectedSdkTagRef({ ref: tagRef(), tagObject: undefined }, EXPECTED).join(""),
    ).toContain("must be dereferenced");
  });

  it.each([
    ["a different ref", { ref: "refs/tags/sdk-v0.1.0-beta.3" }],
    [
      "a lightweight ref where an annotated one is expected",
      { object: { type: "commit", sha: EXPECTED.tagRefObject } },
    ],
    ["a different tag object", { object: { type: "tag", sha: "0".repeat(40) } }],
  ])("refuses %s", (_label, override) => {
    expect(
      validateExpectedSdkTagRef(
        { ref: { ...tagRef(), ...override }, tagObject: tagObject() },
        EXPECTED,
      ),
    ).not.toEqual([]);
  });

  it("refuses a tag that resolves to another commit", () => {
    const failures = validateExpectedSdkTagRef(
      {
        ref: tagRef(),
        tagObject: { ...tagObject(), object: { type: "commit", sha: "a".repeat(40) } },
      },
      EXPECTED,
    );
    expect(failures.join("")).toContain("tag resolves to");
  });

  it("refuses a capture that dereferences correctly but identifies nothing", () => {
    // `{ object: { type: "commit", sha: "516b247…" } }` used to pass: right commit, no tag name, no
    // object SHA, no link back to the ref. The same absent-evidence hole closed for assets and npm
    // metadata, left open one level down.
    const failures = validateExpectedSdkTagRef(
      {
        ref: tagRef(),
        tagObject: { object: { type: "commit", sha: EXPECTED.tagCommit } },
      },
      EXPECTED,
    );
    expect(failures.join("")).toContain("embedded tag name");
    expect(failures.join("")).toContain("captured tag object sha");
  });

  it.each([
    ["a missing embedded tag name", { tag: undefined }],
    ["a different embedded tag name", { tag: "sdk-v0.1.0-beta.1" }],
    ["a missing tag object sha", { sha: undefined }],
    ["a tag object sha that is not the recorded one", { sha: "c".repeat(40) }],
  ])("refuses %s", (_label, override) => {
    expect(
      validateExpectedSdkTagRef(
        { ref: tagRef(), tagObject: { ...tagObject(), ...override } },
        EXPECTED,
      ),
    ).not.toEqual([]);
  });

  it("refuses a tag object that is not the one the ref names", () => {
    // Right tag name, right commit, but a different object than the ref points at.
    const failures = validateExpectedSdkTagRef(
      {
        ref: { ...tagRef(), object: { type: "tag", sha: "d".repeat(40) } },
        tagObject: tagObject(),
      },
      EXPECTED,
    );
    expect(failures.join("")).toContain("is not the object the ref names");
  });

  it.each([
    ["the dereferenced commit", { object: { type: "commit", sha: "b".repeat(40) } }],
    ["the tag object sha", { sha: "e".repeat(40) }],
    ["the embedded tag name", { tag: "sdk-v0.1.0-beta.1" }],
  ])("reports a change to %s between the two captures", (_label, override) => {
    // The whole chain is compared, not just its endpoint: the ref, the object it names, that
    // object's own identity, and the commit it dereferences to.
    const before = immutableSdkTagProjection({ ref: tagRef(), tagObject: tagObject() });
    const after = immutableSdkTagProjection({
      ref: tagRef(),
      tagObject: { ...tagObject(), ...override },
    });
    expect(compareSdkReleaseStates(before, after)).not.toEqual([]);
  });

  it("passes when the whole chain is unchanged", () => {
    const projection = immutableSdkTagProjection({ ref: tagRef(), tagObject: tagObject() });
    expect(compareSdkReleaseStates(projection, projection)).toEqual([]);
  });
});

describe("SDK Release state — recorded constants stay aligned with the runbook", () => {
  // This reads checked-in files. It does not query GitHub or npm, so it establishes internal
  // agreement between the constants and the procedure — not that either matches live state.
  const runbook = readFileSync(resolve(root, "docs/maintainers/release-sdk.md"), "utf8");

  it("names the same release commit as the runbook", () => {
    expect(runbook).toContain(`readonly RELEASE_COMMIT="${EXPECTED.tagCommit}"`);
  });

  it("names the same tag as the runbook", () => {
    expect(runbook).toContain(`readonly RELEASE_TAG="${EXPECTED.tag}"`);
  });
});
