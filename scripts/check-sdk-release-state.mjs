#!/usr/bin/env node
/**
 * The external state of the published SDK Release, as a contract rather than a spot check.
 *
 * This is the gate in front of an edit to something already published, so its failure mode matters
 * more than its success mode. The first version of it failed **open**: it compared the fields it
 * was given and said nothing about the ones it was not. Run against a capture whose assets carried
 * only names, whose `dist` was `{}`, and whose `latest` pointed at `evil-version`, it printed three
 * ticks and exited 0 — `undefined === undefined` for every identity it claimed to be checking.
 * A check that reports success on absent evidence is worse than no check, because it is quoted as
 * proof.
 *
 * So every value is required, typed, and compared against the state actually recorded for
 * `sdk-v0.1.0-beta.2`. Absence is a failure, not a match.
 *
 * Two questions, kept apart:
 *
 * **Is this the Release the procedure expects?** Against `EXPECTED_SDK_RELEASE_STATE`, before
 * anything is edited. A before/after comparison cannot answer this — it proves only that nothing
 * moved, which a Release that was already wrong satisfies perfectly.
 *
 * **Did the edit change only what it was allowed to?** The *enumerated* immutable projection
 * below, compared between two captures. It is a listed set, not every field GitHub returns:
 * `id`, `node_id`, `created_at`, `published_at`, `author`, and the URL fields are outside it and
 * are not established by this check. `name` and `body` are excluded on purpose — they are what the
 * edit changes — and are checked against the corrected presentation instead.
 *
 * **And is the corrected presentation the intended one?** The title and body after the edit, against
 * the expected title and the generated file. A runbook command carrying the right `--title` is not
 * evidence that the published Release carries it.
 *
 * On `target_commitish`: it is `main`, a branch name, not the commit the artifact was built from.
 * The tag is what resolves to `516b247`, so the commit is checked separately and supplied by the
 * caller — deriving a release target from `target_commitish` would read whatever `main` holds today,
 * which is exactly the drift this procedure exists to avoid.
 *
 * Pure except for the CLI at the bottom, behind a main guard: importing this runs nothing. Node
 * built-ins only.
 */
import { readFileSync, realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

/** The recorded state of the published Release, its package, and the package's dist-tags. */
export const EXPECTED_SDK_RELEASE_STATE = Object.freeze({
  tag: "sdk-v0.1.0-beta.2",
  /** The branch the Release records, not a commit. The tag below is the artifact's source. */
  targetCommitish: "main",
  tagCommit: "516b2473a7adaa24dd250ec20f916cf53bd9fa28",
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

/** What the corrected Release must be titled. The published one still carries the duplicated `v`. */
export const EXPECTED_SDK_RELEASE_TITLE = "@fairux/sdk 0.1.0-beta.2";

/**
 * The tag as GitHub holds it, which is what actually ties the Release to a commit.
 *
 * `sdk-v0.1.0-beta.2` is an **annotated** tag: `git/ref/tags/…` returns the tag *object*
 * `35cdf68`, and only dereferencing that through `git/tags/…` reaches the commit `516b247`.
 * Reading `object.sha` from the ref alone would compare a tag object against a commit SHA and
 * always disagree — the shape was checked against the live API rather than assumed.
 */
export const EXPECTED_SDK_TAG_REF = Object.freeze({
  ref: "refs/tags/sdk-v0.1.0-beta.2",
  objectType: "tag",
  tagObject: "35cdf68278afb864a1e01ebdc4250ba197c5f797",
});

const isPlainObject = (value) =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);

const isPositiveInteger = (value) => Number.isSafeInteger(value) && value > 0;
const isNonEmptyString = (value) => typeof value === "string" && value !== "";

/**
 * Every way the captured state can fail to be the one this procedure may edit.
 *
 * Returns the failures rather than throwing, so a caller can report all of them at once — a gate
 * that reveals one problem per run invites fixing them one at a time.
 */
export function validateExpectedSdkReleaseState({ release, npmMetadata, distTags }) {
  const failures = [];
  const fail = (message) => failures.push(message);
  const expect = (actual, expected, label) => {
    if (actual !== expected)
      fail(`${label} is ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
  };

  if (!isPlainObject(release)) {
    return ["release capture is not a JSON object"];
  }

  expect(release.tag_name, EXPECTED_SDK_RELEASE_STATE.tag, "tag_name");
  expect(release.target_commitish, EXPECTED_SDK_RELEASE_STATE.targetCommitish, "target_commitish");
  expect(release.prerelease, EXPECTED_SDK_RELEASE_STATE.prerelease, "prerelease");
  expect(release.draft, EXPECTED_SDK_RELEASE_STATE.draft, "draft");

  // --- assets: present, typed, unique, and exactly the recorded identities -----------------------
  const assets = release.assets;
  if (!Array.isArray(assets)) {
    fail("assets is not an array");
  } else {
    const names = assets.map((asset) => (isPlainObject(asset) ? asset.name : undefined));
    const duplicates = names.filter((name, index) => names.indexOf(name) !== index);
    if (duplicates.length > 0)
      fail(`duplicate asset names: ${[...new Set(duplicates)].join(", ")}`);
    if (assets.length !== EXPECTED_SDK_RELEASE_STATE.assets.length) {
      fail(`asset count is ${assets.length}, expected ${EXPECTED_SDK_RELEASE_STATE.assets.length}`);
    }

    for (const expected of EXPECTED_SDK_RELEASE_STATE.assets) {
      const actual = assets.find((asset) => isPlainObject(asset) && asset.name === expected.name);
      if (!actual) {
        fail(`asset ${expected.name} is missing`);
        continue;
      }
      // Presence and type first: a `digest` that is absent must read as "not established", never
      // as a value that happens to equal the other capture's absence.
      if (!isPositiveInteger(actual.id)) fail(`asset ${expected.name} has no numeric id`);
      if (!isPositiveInteger(actual.size)) fail(`asset ${expected.name} has no numeric size`);
      if (!isNonEmptyString(actual.digest)) fail(`asset ${expected.name} has no digest`);
      if (!isNonEmptyString(actual.content_type))
        fail(`asset ${expected.name} has no content_type`);

      for (const field of ["id", "size", "digest", "content_type"]) {
        if (actual[field] !== undefined && actual[field] !== expected[field]) {
          expect(actual[field], expected[field], `asset ${expected.name} ${field}`);
        }
      }
    }

    for (const asset of assets) {
      const name = isPlainObject(asset) ? asset.name : undefined;
      if (!EXPECTED_SDK_RELEASE_STATE.assets.some((expected) => expected.name === name)) {
        fail(`unexpected asset ${JSON.stringify(name)}`);
      }
    }
  }

  // --- npm metadata: every field required, then compared -----------------------------------------
  if (!isPlainObject(npmMetadata)) {
    fail("npm capture is not a JSON object");
  } else {
    const dist = npmMetadata.dist;
    expect(npmMetadata.version, EXPECTED_SDK_RELEASE_STATE.npm.version, "npm version");
    if (!isPlainObject(dist)) {
      fail("npm dist is missing");
    } else {
      if (!/^[0-9a-f]{40}$/.test(String(dist.shasum)))
        fail(`npm dist.shasum is not 40 hex: ${dist.shasum}`);
      if (!isNonEmptyString(dist.integrity)) fail("npm dist.integrity is missing");
      if (!isNonEmptyString(dist.tarball) || !dist.tarball.startsWith("https://")) {
        fail(`npm dist.tarball is not an HTTPS URL: ${dist.tarball}`);
      }
      if (!isPositiveInteger(dist.fileCount)) fail("npm dist.fileCount is missing");
      if (!isPositiveInteger(dist.unpackedSize)) fail("npm dist.unpackedSize is missing");

      for (const [field, expected] of [
        ["shasum", EXPECTED_SDK_RELEASE_STATE.npm.shasum],
        ["integrity", EXPECTED_SDK_RELEASE_STATE.npm.integrity],
        ["tarball", EXPECTED_SDK_RELEASE_STATE.npm.tarball],
        ["fileCount", EXPECTED_SDK_RELEASE_STATE.npm.fileCount],
        ["unpackedSize", EXPECTED_SDK_RELEASE_STATE.npm.unpackedSize],
      ]) {
        if (dist[field] !== undefined && dist[field] !== expected) {
          expect(dist[field], expected, `npm dist.${field}`);
        }
      }
    }
  }

  // --- dist-tags: the whole map, with no extra channel ------------------------------------------
  if (!isPlainObject(distTags)) {
    fail("dist-tags capture is not a JSON object");
  } else {
    const expectedTags = EXPECTED_SDK_RELEASE_STATE.distTags;
    for (const [tag, version] of Object.entries(expectedTags)) {
      if (!Object.hasOwn(distTags, tag)) fail(`dist-tag ${tag} is missing`);
      else expect(distTags[tag], version, `dist-tag ${tag}`);
    }
    for (const tag of Object.keys(distTags)) {
      if (!Object.hasOwn(expectedTags, tag)) {
        fail(
          `unexpected dist-tag ${tag}=${distTags[tag]}; a new channel is a decision, not a detail`,
        );
      }
    }
  }

  return failures;
}

/**
 * Every way the tag GitHub holds fails to be the one this Release was built from.
 *
 * The local tag is not evidence: a stale `refs/tags` in a working copy answers `git rev-parse`
 * just as readily as a current one. This reads what github.com returns.
 */
export function validateExpectedSdkTagRef({ ref, tagObject }) {
  const failures = [];
  const fail = (message) => failures.push(message);

  if (!isPlainObject(ref)) return ["tag ref capture is not a JSON object"];
  if (ref.ref !== EXPECTED_SDK_TAG_REF.ref) {
    fail(
      `tag ref is ${JSON.stringify(ref.ref)}, expected ${JSON.stringify(EXPECTED_SDK_TAG_REF.ref)}`,
    );
  }
  if (ref.object?.type !== EXPECTED_SDK_TAG_REF.objectType) {
    fail(`tag ref object type is ${JSON.stringify(ref.object?.type)}, expected "tag"`);
  }
  if (ref.object?.sha !== EXPECTED_SDK_TAG_REF.tagObject) {
    fail(
      `tag object is ${JSON.stringify(ref.object?.sha)}, expected ${EXPECTED_SDK_TAG_REF.tagObject}`,
    );
  }

  if (!isPlainObject(tagObject)) {
    fail("tag object capture is not a JSON object; an annotated tag must be dereferenced");
    return failures;
  }
  if (tagObject.object?.type !== "commit") {
    fail(`tag dereferences to ${JSON.stringify(tagObject.object?.type)}, expected a commit`);
  }
  if (tagObject.object?.sha !== EXPECTED_SDK_RELEASE_STATE.tagCommit) {
    fail(
      `tag resolves to ${JSON.stringify(tagObject.object?.sha)}, expected ${EXPECTED_SDK_RELEASE_STATE.tagCommit}`,
    );
  }
  return failures;
}

/** The tag identity two captures are compared by. */
export function immutableSdkTagProjection({ ref, tagObject }) {
  return {
    ref: ref?.ref,
    tagObject: ref?.object?.sha,
    objectType: ref?.object?.type,
    commit: tagObject?.object?.sha,
  };
}

/**
 * The title and body the correction was supposed to produce.
 *
 * Separate from the immutable projection, which deliberately excludes both. A `gh release edit`
 * command carrying the right `--title` says what was asked for; this says what is published.
 */
export function validateCorrectedSdkReleasePresentation({ release, generatedBody }) {
  const failures = [];
  if (release?.name !== EXPECTED_SDK_RELEASE_TITLE) {
    failures.push(
      `Release title is ${JSON.stringify(release?.name)}, expected ${JSON.stringify(EXPECTED_SDK_RELEASE_TITLE)}`,
    );
  }
  failures.push(...compareSdkReleaseBody(release?.body, generatedBody));
  return failures;
}

/** The enumerated fields the edit must leave alone, in a form two captures can be compared by. */
export function immutableSdkReleaseProjection({ release, npmMetadata, distTags }) {
  return {
    tag_name: release?.tag_name,
    target_commitish: release?.target_commitish,
    prerelease: release?.prerelease,
    draft: release?.draft,
    assets: (Array.isArray(release?.assets) ? release.assets : [])
      .map((asset) => ({
        id: asset?.id,
        name: asset?.name,
        size: asset?.size,
        digest: asset?.digest,
        content_type: asset?.content_type,
      }))
      .sort((a, b) => (String(a.name) < String(b.name) ? -1 : 1)),
    npm: {
      version: npmMetadata?.version,
      shasum: npmMetadata?.dist?.shasum,
      integrity: npmMetadata?.dist?.integrity,
      tarball: npmMetadata?.dist?.tarball,
      fileCount: npmMetadata?.dist?.fileCount,
      unpackedSize: npmMetadata?.dist?.unpackedSize,
    },
    distTags: isPlainObject(distTags) ? { ...distTags } : distTags,
  };
}

/** Differences between two projections, or an empty list. */
export function compareSdkReleaseStates(before, after) {
  const left = JSON.stringify(before);
  const right = JSON.stringify(after);
  if (left === right) return [];
  return [`immutable state changed:\n    before: ${left}\n    after:  ${right}`];
}

/**
 * Compare the published body against the file that was uploaded.
 *
 * GitHub returns the body with CRLF line endings, so CRLF is folded to LF — and only CRLF. An
 * earlier version stripped every `\r`, which made `ab\rc\n` equal to `abc\n`: a standalone carriage
 * return in the published body would have read as a match. Nothing else is normalised; a trim would
 * hide exactly the trailing-newline drift the generator's contract exists to pin.
 *
 * Exact source-text equality on the decoded strings, not a byte comparison: the capture has already
 * been through `JSON.parse`, and the lengths reported below are UTF-16 code units.
 */
export function compareSdkReleaseBody(published, generated) {
  if (typeof published !== "string") return ["Release body is missing"];
  const normalized = published.replaceAll("\r\n", "\n");
  if (normalized.includes("\r")) {
    return ["Release body contains a standalone carriage return"];
  }
  if (normalized !== generated) {
    return [
      `Release body differs from the generated notes (${normalized.length} vs ${generated.length} UTF-16 code units after CRLF folding)`,
    ];
  }
  return [];
}

function argument(name, { required = true } = {}) {
  const index = process.argv.indexOf(`--${name}`);
  const value = index === -1 ? null : process.argv[index + 1];
  if (required && !value) {
    console.error(`ERROR: --${name} is required`);
    process.exit(2);
  }
  return value;
}

function main() {
  const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));

  const release = readJson(argument("release"));
  const npmMetadata = readJson(argument("npm"));
  const distTags = readJson(argument("dist-tags"));
  const tagRef = readJson(argument("tag-ref"));
  const tagObject = readJson(argument("tag-object"));

  const failures = validateExpectedSdkReleaseState({ release, npmMetadata, distTags });
  failures.push(...validateExpectedSdkTagRef({ ref: tagRef, tagObject }));

  const beforePath = argument("before", { required: false });
  if (beforePath) {
    failures.push(
      ...compareSdkReleaseStates(
        immutableSdkReleaseProjection({
          release: readJson(beforePath),
          npmMetadata: readJson(argument("npm-before")),
          distTags: readJson(argument("dist-tags-before")),
        }),
        immutableSdkReleaseProjection({ release, npmMetadata, distTags }),
      ),
    );
    failures.push(
      ...compareSdkReleaseStates(
        immutableSdkTagProjection({
          ref: readJson(argument("tag-ref-before")),
          tagObject: readJson(argument("tag-object-before")),
        }),
        immutableSdkTagProjection({ ref: tagRef, tagObject }),
      ),
    );
  }

  const bodyPath = argument("body", { required: false });
  if (bodyPath) {
    failures.push(
      ...validateCorrectedSdkReleasePresentation({
        release,
        generatedBody: readFileSync(bodyPath, "utf8"),
      }),
    );
  }

  if (failures.length > 0) {
    console.error("✖ SDK Release state check failed:\n");
    for (const failure of failures) console.error(`  - ${failure}`);
    console.error("\nDo not edit the Release. Resolve every item first.");
    process.exit(1);
  }

  console.log(
    `✓ ${EXPECTED_SDK_RELEASE_STATE.tag} matches the recorded Release, tag, package, and dist-tags`,
  );
  if (beforePath) console.log("✓ the enumerated immutable projection is unchanged");
  if (bodyPath) console.log("✓ the published title and body match the corrected presentation");
}

function isEntryPoint() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(entry)).href;
  } catch {
    return false;
  }
}

if (isEntryPoint()) main();
