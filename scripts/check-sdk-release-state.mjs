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
 * So every value is required, typed, and compared against a written-down expectation. Absence is a
 * failure, not a match — including absence in the expectation itself, which is why
 * `validateSdkReleaseExpectation` exists: the expectation is a `--expected` file now rather than a
 * constant, so it is input, and input is exactly what the first version trusted.
 *
 * Two questions, kept apart:
 *
 * **Is this the Release the procedure expects?** Against the expectation, before anything is
 * edited. A before/after comparison cannot answer this — it proves only that nothing moved, which a
 * Release that was already wrong satisfies perfectly.
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
 * On `target_commitish`: it is a branch name, not the commit the artifact was built from. The tag
 * is what resolves to a commit, so the commit is expected separately — deriving a release target
 * from `target_commitish` would read whatever that branch holds today, which is exactly the drift
 * this procedure exists to avoid.
 *
 * Pure except for the CLI at the bottom, behind a main guard: importing this runs nothing. Node
 * built-ins only.
 */
import { readFileSync, realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

const isPlainObject = (value) =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);

const isPositiveInteger = (value) => Number.isSafeInteger(value) && value > 0;
const isNonEmptyString = (value) => typeof value === "string" && value !== "";

/**
 * The expectation itself, which is now input rather than a constant, and therefore untrusted.
 *
 * This used to be `EXPECTED_SDK_RELEASE_STATE`, frozen to `sdk-v0.1.0-beta.2` — the correction that
 * needed it. A gate hard-coded to one release can only ever guard that release, and this one was
 * still the only defence when the documentation reorganisation broke the links in every published
 * Release body.
 *
 * Making it a parameter reopens the failure mode the whole file exists to prevent: an absent or
 * half-written expectation must be a **refusal**, never an empty comparison that prints a tick.
 * Every field below is required, and `undefined === undefined` is not an agreement.
 */
export function validateSdkReleaseExpectation(expected) {
  const failures = [];
  const fail = (message) => failures.push(`expectation: ${message}`);
  if (!isPlainObject(expected)) return ["expectation is not a JSON object"];

  for (const field of ["tag", "targetCommitish", "tagCommit", "title", "tagRefObject"]) {
    if (!isNonEmptyString(expected[field])) fail(`${field} is missing`);
  }
  for (const field of ["prerelease", "draft"]) {
    if (typeof expected[field] !== "boolean") fail(`${field} is not a boolean`);
  }

  if (!Array.isArray(expected.assets) || expected.assets.length === 0) {
    fail("assets is not a non-empty array");
  } else {
    for (const asset of expected.assets) {
      if (!isPlainObject(asset)) {
        fail("an asset is not an object");
        continue;
      }
      if (!isNonEmptyString(asset.name)) fail("an asset has no name");
      if (!isPositiveInteger(asset.id)) fail(`asset ${asset.name} has no numeric id`);
      if (!isPositiveInteger(asset.size)) fail(`asset ${asset.name} has no numeric size`);
      if (!isNonEmptyString(asset.digest)) fail(`asset ${asset.name} has no digest`);
      if (!isNonEmptyString(asset.content_type)) fail(`asset ${asset.name} has no content_type`);
    }
  }

  if (!isPlainObject(expected.npm)) {
    fail("npm is missing");
  } else {
    for (const field of ["version", "shasum", "integrity", "tarball"]) {
      if (!isNonEmptyString(expected.npm[field])) fail(`npm.${field} is missing`);
    }
    for (const field of ["fileCount", "unpackedSize"]) {
      if (!isPositiveInteger(expected.npm[field])) fail(`npm.${field} is missing`);
    }
  }

  if (!isPlainObject(expected.distTags) || Object.keys(expected.distTags).length === 0) {
    fail("distTags is not a non-empty object");
  } else {
    for (const [tag, version] of Object.entries(expected.distTags)) {
      if (!isNonEmptyString(version)) fail(`distTags.${tag} is not a version`);
    }
  }

  return failures;
}

/**
 * Every way the captured state can fail to be the one this procedure may edit.
 *
 * Returns the failures rather than throwing, so a caller can report all of them at once — a gate
 * that reveals one problem per run invites fixing them one at a time.
 */
export function validateExpectedSdkReleaseState({ release, npmMetadata, distTags }, expected) {
  const failures = [];
  const fail = (message) => failures.push(message);
  const expect = (actual, expected, label) => {
    if (actual !== expected)
      fail(`${label} is ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
  };

  if (!isPlainObject(release)) {
    return ["release capture is not a JSON object"];
  }

  expect(release.tag_name, expected.tag, "tag_name");
  expect(release.target_commitish, expected.targetCommitish, "target_commitish");
  expect(release.prerelease, expected.prerelease, "prerelease");
  expect(release.draft, expected.draft, "draft");

  // --- assets: present, typed, unique, and exactly the recorded identities -----------------------
  const assets = release.assets;
  if (!Array.isArray(assets)) {
    fail("assets is not an array");
  } else {
    const names = assets.map((asset) => (isPlainObject(asset) ? asset.name : undefined));
    const duplicates = names.filter((name, index) => names.indexOf(name) !== index);
    if (duplicates.length > 0)
      fail(`duplicate asset names: ${[...new Set(duplicates)].join(", ")}`);
    if (assets.length !== expected.assets.length) {
      fail(`asset count is ${assets.length}, expected ${expected.assets.length}`);
    }

    for (const expectedAsset of expected.assets) {
      const actual = assets.find(
        (asset) => isPlainObject(asset) && asset.name === expectedAsset.name,
      );
      if (!actual) {
        fail(`asset ${expectedAsset.name} is missing`);
        continue;
      }
      // Presence and type first: a `digest` that is absent must read as "not established", never
      // as a value that happens to equal the other capture's absence.
      if (!isPositiveInteger(actual.id)) fail(`asset ${expectedAsset.name} has no numeric id`);
      if (!isPositiveInteger(actual.size)) fail(`asset ${expectedAsset.name} has no numeric size`);
      if (!isNonEmptyString(actual.digest)) fail(`asset ${expectedAsset.name} has no digest`);
      if (!isNonEmptyString(actual.content_type))
        fail(`asset ${expectedAsset.name} has no content_type`);

      for (const field of ["id", "size", "digest", "content_type"]) {
        if (actual[field] !== undefined && actual[field] !== expectedAsset[field]) {
          expect(actual[field], expectedAsset[field], `asset ${expectedAsset.name} ${field}`);
        }
      }
    }

    for (const asset of assets) {
      const name = isPlainObject(asset) ? asset.name : undefined;
      if (!expected.assets.some((expectedAsset) => expectedAsset.name === name)) {
        fail(`unexpected asset ${JSON.stringify(name)}`);
      }
    }
  }

  // --- npm metadata: every field required, then compared -----------------------------------------
  if (!isPlainObject(npmMetadata)) {
    fail("npm capture is not a JSON object");
  } else {
    const dist = npmMetadata.dist;
    expect(npmMetadata.version, expected.npm.version, "npm version");
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

      for (const [field, expectedValue] of [
        ["shasum", expected.npm.shasum],
        ["integrity", expected.npm.integrity],
        ["tarball", expected.npm.tarball],
        ["fileCount", expected.npm.fileCount],
        ["unpackedSize", expected.npm.unpackedSize],
      ]) {
        if (dist[field] !== undefined && dist[field] !== expectedValue) {
          expect(dist[field], expectedValue, `npm dist.${field}`);
        }
      }
    }
  }

  // --- dist-tags: the whole map, with no extra channel ------------------------------------------
  if (!isPlainObject(distTags)) {
    fail("dist-tags capture is not a JSON object");
  } else {
    const expectedTags = expected.distTags;
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
export function validateExpectedSdkTagRef({ ref, tagObject }, expected) {
  const failures = [];
  const fail = (message) => failures.push(message);

  if (!isPlainObject(ref)) return ["tag ref capture is not a JSON object"];
  if (ref.ref !== `refs/tags/${expected.tag}`) {
    fail(
      `tag ref is ${JSON.stringify(ref.ref)}, expected ${JSON.stringify(`refs/tags/${expected.tag}`)}`,
    );
  }
  if (ref.object?.type !== "tag") {
    fail(`tag ref object type is ${JSON.stringify(ref.object?.type)}, expected "tag"`);
  }
  if (ref.object?.sha !== expected.tagRefObject) {
    fail(`tag object is ${JSON.stringify(ref.object?.sha)}, expected ${expected.tagRefObject}`);
  }

  if (!isPlainObject(tagObject)) {
    fail("tag object capture is not a JSON object; an annotated tag must be dereferenced");
    return failures;
  }

  // The capture has to *be* the tag object the ref names, not merely something that dereferences
  // to the right commit. Without this, `{ object: { type: "commit", sha: "516b247…" } }` passed —
  // no tag name, no object SHA, no link back to the ref — which is the same absent-evidence hole
  // this file closed for assets and npm metadata.
  if (tagObject.tag !== expected.tag) {
    fail(
      `embedded tag name is ${JSON.stringify(tagObject.tag)}, expected ${JSON.stringify(expected.tag)}`,
    );
  }
  if (tagObject.sha !== expected.tagRefObject) {
    fail(
      `captured tag object sha is ${JSON.stringify(tagObject.sha)}, expected ${expected.tagRefObject}`,
    );
  }
  if (tagObject.sha !== ref.object?.sha) {
    fail(
      `tag object capture ${JSON.stringify(tagObject.sha)} is not the object the ref names, ${JSON.stringify(ref.object?.sha)}`,
    );
  }

  if (tagObject.object?.type !== "commit") {
    fail(`tag dereferences to ${JSON.stringify(tagObject.object?.type)}, expected a commit`);
  }
  if (tagObject.object?.sha !== expected.tagCommit) {
    fail(
      `tag resolves to ${JSON.stringify(tagObject.object?.sha)}, expected ${expected.tagCommit}`,
    );
  }
  return failures;
}

/**
 * The tag identity two captures are compared by — the whole chain, not just its endpoint.
 *
 * The ref, the object it names, the tag object's own name and SHA, and the commit that object
 * dereferences to. Comparing only the final commit would let the chain change underneath while its
 * result stayed the same.
 */
export function immutableSdkTagProjection({ ref, tagObject }) {
  return {
    ref: ref?.ref,
    refObjectType: ref?.object?.type,
    refObjectSha: ref?.object?.sha,
    embeddedTag: tagObject?.tag,
    tagObjectSha: tagObject?.sha,
    targetType: tagObject?.object?.type,
    targetCommit: tagObject?.object?.sha,
  };
}

/**
 * The title and body the correction was supposed to produce.
 *
 * Separate from the immutable projection, which deliberately excludes both. A `gh release edit`
 * command carrying the right `--title` says what was asked for; this says what is published.
 */
export function validateCorrectedSdkReleasePresentation({ release, generatedBody }, expectedTitle) {
  const failures = [];
  if (release?.name !== expectedTitle) {
    failures.push(
      `Release title is ${JSON.stringify(release?.name)}, expected ${JSON.stringify(expectedTitle)}`,
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

  const expected = readJson(argument("expected"));
  // The expectation gates everything below it, so a malformed one stops the run here rather than
  // being compared field by field against a Release and agreeing by absence.
  const expectationFailures = validateSdkReleaseExpectation(expected);
  if (expectationFailures.length > 0) {
    console.error("\u2716 the expected-state file is not usable:\n");
    for (const failure of expectationFailures) console.error(`  - ${failure}`);
    console.error("\nWrite it from the Release you intend to correct, before you edit anything.");
    process.exit(1);
  }

  const release = readJson(argument("release"));
  const npmMetadata = readJson(argument("npm"));
  const distTags = readJson(argument("dist-tags"));
  const tagRef = readJson(argument("tag-ref"));
  const tagObject = readJson(argument("tag-object"));

  const failures = validateExpectedSdkReleaseState({ release, npmMetadata, distTags }, expected);
  failures.push(...validateExpectedSdkTagRef({ ref: tagRef, tagObject }, expected));

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
      ...validateCorrectedSdkReleasePresentation(
        { release, generatedBody: readFileSync(bodyPath, "utf8") },
        expected.title,
      ),
    );
  }

  if (failures.length > 0) {
    console.error("✖ SDK Release state check failed:\n");
    for (const failure of failures) console.error(`  - ${failure}`);
    console.error("\nDo not edit the Release. Resolve every item first.");
    process.exit(1);
  }

  console.log(`✓ ${expected.tag} matches the expected Release, tag, package, and dist-tags`);
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
