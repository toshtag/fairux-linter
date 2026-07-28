#!/usr/bin/env node
/**
 * Check the external state of the published SDK Release, before and after an in-place body edit.
 *
 * Two different questions, and the second does not imply the first:
 *
 * **Is this the Release the procedure expects?** Tag, target commit, prerelease flag, draft flag,
 * asset count, and asset names, compared against values fixed here. A before/after comparison alone
 * would pass just as happily on a Release pointing at the wrong commit or carrying the wrong
 * assets — it only proves nothing *changed*, not that anything was right.
 *
 * **Did the edit change only what it was allowed to?** An immutable projection of the Release, the
 * npm metadata, and the dist-tags, compared between the two captures. `name`, `body`, and
 * `updated_at` are the only fields that may differ.
 *
 * Plus, when `--body` is given, a byte comparison of the Release body against the file that was
 * uploaded. One allowance is made and stated: GitHub returns the body with CRLF line endings, so
 * carriage returns are stripped before comparing. Nothing else is normalised — a trim would hide
 * exactly the trailing-newline drift the generator's contract exists to pin.
 *
 * This reads captured JSON; it makes no network call of its own, so the exact bytes it judged stay
 * on disk as evidence. Node built-ins only.
 */
import { readFileSync } from "node:fs";

const EXPECTED = Object.freeze({
  tag: "sdk-v0.1.0-beta.2",
  targetCommit: "516b2473a7adaa24dd250ec20f916cf53bd9fa28",
  prerelease: true,
  draft: false,
  version: "0.1.0-beta.2",
  assets: Object.freeze(["fairux-sdk-0.1.0-beta.2.tgz", "release-sha256.txt"]),
  distTags: Object.freeze(["next", "latest", "bootstrap"]),
});

function argument(name, { required = true } = {}) {
  const index = process.argv.indexOf(`--${name}`);
  const value = index === -1 ? null : process.argv[index + 1];
  if (required && !value) {
    console.error(`ERROR: --${name} is required`);
    process.exit(2);
  }
  return value;
}

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));

const failures = [];
const check = (condition, message) => {
  if (!condition) failures.push(message);
};

const release = readJson(argument("release"));
const npm = readJson(argument("npm"));
const distTags = readJson(argument("dist-tags"));

// --- Is this the Release the procedure expects? ------------------------------------------------
check(
  release.tag_name === EXPECTED.tag,
  `tag_name is ${release.tag_name}, expected ${EXPECTED.tag}`,
);
check(
  release.target_commitish === EXPECTED.targetCommit,
  `target_commitish is ${release.target_commitish}, expected ${EXPECTED.targetCommit}`,
);
check(release.prerelease === EXPECTED.prerelease, `prerelease is ${release.prerelease}`);
check(release.draft === EXPECTED.draft, `draft is ${release.draft}`);

const assetNames = (release.assets ?? []).map((asset) => asset.name).sort();
check(
  assetNames.length === EXPECTED.assets.length &&
    assetNames.every((name, index) => name === [...EXPECTED.assets].sort()[index]),
  `assets are ${assetNames.join(", ") || "none"}, expected ${[...EXPECTED.assets].sort().join(", ")}`,
);

check(npm.version === EXPECTED.version, `npm version is ${npm.version}`);
check(
  distTags[EXPECTED.distTags[0]] === EXPECTED.version,
  `dist-tag next is ${distTags[EXPECTED.distTags[0]]}, expected ${EXPECTED.version}`,
);
for (const tag of EXPECTED.distTags) {
  check(typeof distTags[tag] === "string", `dist-tag ${tag} is missing`);
}

// --- Did the edit change only what it was allowed to? ------------------------------------------
const beforePath = argument("before", { required: false });
if (beforePath) {
  const projection = (rel, meta, tags) => ({
    tag_name: rel.tag_name,
    target_commitish: rel.target_commitish,
    prerelease: rel.prerelease,
    draft: rel.draft,
    assets: (rel.assets ?? [])
      .map((asset) => ({
        id: asset.id,
        name: asset.name,
        size: asset.size,
        digest: asset.digest ?? null,
        content_type: asset.content_type,
      }))
      .sort((a, b) => (a.name < b.name ? -1 : 1)),
    npm: {
      version: meta.version,
      shasum: meta.dist?.shasum,
      integrity: meta.dist?.integrity,
      tarball: meta.dist?.tarball,
      fileCount: meta.dist?.fileCount,
      unpackedSize: meta.dist?.unpackedSize,
    },
    distTags: Object.fromEntries(EXPECTED.distTags.map((tag) => [tag, tags[tag]])),
  });

  const before = projection(
    readJson(beforePath),
    readJson(argument("npm-before")),
    readJson(argument("dist-tags-before")),
  );
  const after = projection(release, npm, distTags);

  if (JSON.stringify(before) !== JSON.stringify(after)) {
    failures.push(
      `immutable state changed:\n    before: ${JSON.stringify(before)}\n    after:  ${JSON.stringify(after)}`,
    );
  }
}

// --- Is the published body the file that was generated? ----------------------------------------
const bodyPath = argument("body", { required: false });
if (bodyPath) {
  // GitHub returns the body with CRLF endings. That, and nothing else — a trim would hide the
  // trailing-newline drift the generator's own contract exists to pin.
  const published = String(release.body ?? "").replaceAll("\r", "");
  const generated = readFileSync(bodyPath, "utf8");
  check(
    published === generated,
    `Release body differs from the generated notes (${published.length} vs ${generated.length} bytes after CR removal)`,
  );
}

if (failures.length > 0) {
  console.error("✖ SDK Release state check failed:\n");
  for (const failure of failures) console.error(`  - ${failure}`);
  console.error("\nDo not edit the Release. Resolve each item first.");
  process.exit(1);
}

console.log(`✓ SDK Release state matches the expected ${EXPECTED.tag} contract`);
if (beforePath) console.log("✓ every immutable field is unchanged");
if (bodyPath) console.log("✓ the published body is the generated notes");
