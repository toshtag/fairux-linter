#!/usr/bin/env node
/**
 * What makes a corpus page this project did not write permissible to ship, stated so it can fail.
 *
 * Six corpus pages are copies of files from three open-source repositories. They are here because
 * their licences allow it and for no other reason, so the record of where each came from is not
 * documentation — it is the thing that makes the file redistributable. That puts this in the same
 * class as `sarif-canary-contract.mjs`: the refusals are the point, and a refusal that only exists
 * inside the code path it guards is a refusal nobody has read. Hence a separate module with the
 * decisions in it, exercised by `tests/unit/third-party-fixtures-contract.test.ts` against temporary
 * trees, and a CLI that only prints and exits.
 *
 * The first version of this check was reviewed and three of its guarantees turned out to be prose.
 * Each fix below names the bypass that produced it, because "the validator covers that" was true of
 * all three until somebody tried:
 *
 * 1. **The allowed licences were read from the file being checked.** Adding `Proprietary` to
 *    `provenance.allowedLicenses` and to a fixture passed. Policy lives in `ALLOWED_LICENCES` here,
 *    and the JSON no longer carries a copy at all: the first fix required the two to match exactly,
 *    which is a second list plus a test that they agree. Data cannot widen the policy that judges
 *    it, and there is nothing left to keep in step.
 * 2. **Orphans were enumerated from the manifest.** An HTML file dropped into `corpus/third-party/`
 *    and registered nowhere passed, and `biome.json` excludes that directory, so nothing else looked
 *    at it either. The directory is now listed from disk, and disk, provenance and manifest must
 *    agree as sets.
 * 3. **"No external URL" was a regular expression over raw HTML.** `<img src=https://…/tracker>`
 *    passed, because the pattern required quotes. Parsing replaced it: parse5 builds the tree, and
 *    every element and attribute is inspected as syntax rather than as text.
 *
 * The licence texts are the fourth correction and were not a bypass but a false claim: the notice
 * said it carried the permission notice and carried only a link. MIT asks for the permission notice
 * to travel with the copy, so each source's licence file is stored here, hashed, and reproduced in
 * the generated notice.
 */

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { parse } from "parse5";

/**
 * The licences this repository will redistribute a corpus fixture under.
 *
 * **In code, deliberately.** The first version read this list out of `provenance.json`, which meant
 * a change adding a forbidden licence and the change permitting it were the same edit to the same
 * file. A policy the data it judges can rewrite is not a policy.
 *
 * `CC-BY-4.0` is absent on purpose rather than by oversight: attribution-only licences are workable
 * for a fixture, and adding one is a decision somebody should make in a diff to this line.
 */
export const ALLOWED_LICENCES = Object.freeze([
  "0BSD",
  "Apache-2.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "CC0-1.0",
  "ISC",
  "MIT",
]);

/**
 * What a source record must carry, and what a fixture record must carry.
 *
 * Two lists because the file has two shapes. Repository, commit, licence and copyright are facts
 * about a *source*, and every fixture from the same repository shares them — they used to be
 * repeated on each fixture, so three sources were written six times and a correction to one had to
 * be applied twice to be true.
 *
 * A fixture keeps only what differs between two files from the same source: which case it is, where
 * it came from inside that repository, the digest of the bytes shipped here, and why it was chosen.
 *
 * Four fields are gone rather than moved. `capturedAt` was a date nothing read, which git history
 * answers more precisely. `originalSha256` was the digest of a file this repository does not keep
 * and never fetches, so nothing could ever compare it. `reductionNotes` was a hand-written subset of
 * `reduction.rules` that no output rendered. `modifiedForDetection` was `false` on every fixture and
 * refused any other value, which makes it a constant restated six times rather than a record.
 *
 * `selectedBecause` is required and non-empty: it records that a fixture was chosen for the shape of
 * its markup *before* anything was scanned, and a corpus that had quietly kept the pages a rule
 * happened to agree with would look identical without it.
 */
export const REQUIRED_SOURCE_FIELDS = Object.freeze([
  "id",
  "repository",
  "commit",
  "licenseSpdx",
  "licensePath",
  "licenseNoticeFile",
  "licenseNoticeSha256",
  "copyrightHolder",
]);

/** @see REQUIRED_SOURCE_FIELDS */
export const REQUIRED_FIXTURE_FIELDS = Object.freeze([
  "caseId",
  "file",
  "sourceId",
  "sourcePath",
  "reducedSha256",
  "selectedBecause",
]);

/** A field a record must carry: absent, null, empty string, or empty array all count as missing. */
function isEmpty(value) {
  return (
    value === undefined ||
    value === null ||
    value === "" ||
    (Array.isArray(value) && value.length === 0)
  );
}

/** Elements that mean the page was never reduced. */
const FORBIDDEN_ELEMENTS = Object.freeze(["script", "iframe", "link", "style", "noscript"]);

/**
 * Attributes that fetch, submit, or execute.
 *
 * `href` is not here: a reduced page keeps its links, and what it may not keep is an *absolute* one.
 * That is checked separately, for every attribute, by value.
 */
const FETCHING_ATTRIBUTES = Object.freeze(["src", "srcset", "poster", "action", "formaction"]);

/** `https://x`, `HTTP://x`, and `//x` — the last is the one a scheme-matching regex misses. */
const EXTERNAL_URL = /^\s*(?:[a-z][a-z0-9+.-]*:)?\/\//i;

/** `third-party/<name>.html`, and nothing that resolves anywhere else. */
const FIXTURE_PATH = /^third-party\/[A-Za-z0-9][A-Za-z0-9._-]*\.html$/;

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

/**
 * Is `file` a fixture path that cannot escape `corpus/third-party/`?
 *
 * Checked twice, by shape and by resolution. The shape rule refuses `..` and subdirectories outright;
 * resolving then refuses whatever the shape rule failed to imagine. A prefix comparison on the
 * *unresolved* string — which is what the first version did — accepts `third-party/../README.md`.
 */
export function fixturePathProblem(file, corpusDir) {
  if (typeof file !== "string" || !FIXTURE_PATH.test(file)) {
    return `${JSON.stringify(file)} is not of the form third-party/<name>.html`;
  }
  const resolved = resolve(corpusDir, file);
  const root = resolve(corpusDir, "third-party") + sep;
  if (!resolved.startsWith(root))
    return `${JSON.stringify(file)} resolves outside corpus/third-party`;
  return null;
}

/**
 * Everything in `html` that a reduced fixture may not contain, found by parsing rather than matching.
 *
 * The distinction is the whole point. `<img src=https://example.com/tracker>` is valid HTML with an
 * unquoted attribute; parse5 reports the attribute value, and a pattern written around quotes does
 * not. Case, whitespace, attribute order and quoting style stop mattering once the tree exists.
 */
export function reductionProblems(html) {
  const problems = new Set();
  const walk = (node) => {
    const tag = node.nodeName;
    if (FORBIDDEN_ELEMENTS.includes(tag)) problems.add(`a <${tag}> element`);
    for (const attribute of node.attrs ?? []) {
      const name = attribute.name.toLowerCase();
      const value = attribute.value ?? "";
      if (name.startsWith("on")) problems.add(`an inline event handler (${name})`);
      if (FETCHING_ATTRIBUTES.includes(name)) {
        problems.add(`a fetching attribute (${tag}[${name}])`);
      }
      if (EXTERNAL_URL.test(value)) {
        problems.add(`an off-site URL in ${tag}[${name}]`);
      }
    }
    for (const child of node.childNodes ?? []) walk(child);
  };
  walk(parse(html));
  return [...problems].sort();
}

/** The notice, derived from provenance and the stored licence texts rather than kept beside them. */
export function renderNotice(provenance, licenceTexts) {
  const sourceById = new Map(provenance.sources.map((source) => [source.id, source]));

  const rows = provenance.fixtures.map((fixture) => {
    const source = sourceById.get(fixture.sourceId);
    return (
      `| \`${fixture.file.split("/").pop()}\` | [${source.id}](${source.repository}) | ` +
      `\`${source.commit.slice(0, 8)}\` | \`${fixture.sourcePath}\` | ` +
      `${source.licenseSpdx} | ${source.copyrightHolder} |`
    );
  });

  const texts = provenance.sources.map((source) => {
    const text = licenceTexts.get(source.licenseNoticeFile);
    const body = text
      .trimEnd()
      .split("\n")
      .map((line) => (line.length > 0 ? `> ${line}` : ">"))
      .join("\n");
    // A licence file with no copyright line is upstream's, not ours to correct. Saying which of the
    // two the holder came from is the difference between quoting and asserting.
    const attribution = /copyright/i.test(text)
      ? `${source.licenseSpdx}, copyright ${source.copyrightHolder} as stated in the licence text below.`
      : `${source.licenseSpdx}. The licence text below names no copyright holder; ` +
        `${source.copyrightHolder} is taken from the source's \`package.json\` at the same commit ` +
        "and is recorded as an inference.";
    return [
      `### ${source.id}`,
      "",
      attribution,
      "",
      `Taken from \`${source.licensePath}\` at \`${source.commit}\` and stored here as`,
      `[\`licenses/${source.licenseNoticeFile}\`](licenses/${source.licenseNoticeFile}).`,
      "",
      body,
    ].join("\n");
  });

  return `${[
    "<!-- Generated by scripts/third-party-fixtures-contract.mjs. Do not edit by hand. -->",
    "",
    "# Third-party corpus fixtures",
    "",
    "Some pages in this corpus were not written here. They are reduced copies of files from",
    "open-source projects, each carrying a licence that permits redistribution. This file is the",
    "attribution and the permission notice those licences ask for; `provenance.json` beside it is the",
    "machine-readable record, and `pnpm check:third-party-fixtures` fails if the two disagree or if a",
    "fixture drifts from what is recorded.",
    "",
    "It is generated from `provenance.json` and the licence texts under `licenses/`, and checked byte",
    "for byte. An earlier hand-written version claimed to carry the permission notice while carrying",
    "only a link to it, which is the kind of thing a document says about itself and a generator cannot.",
    "",
    "| Fixture | Source | Commit | Original path | Licence | Copyright |",
    "| --- | --- | --- | --- | --- | --- |",
    ...rows,
    "",
    "## What was removed, and what is checked",
    "",
    "Each copy was reduced by applying these rules with `parse5` — the parser `@fairux/html` reads",
    "pages with — and never by hand:",
    "",
    ...provenance.reduction.rules.map((rule) => `- ${rule}`),
    "",
    "**What the check verifies, on every run:** each file's SHA-256 matches the digest recorded in",
    "`provenance.json`, so no copy here can be edited without the build saying so; each contains no",
    "`<script>`, `<iframe>`, `<link>`, `<style>` or `<noscript>`, no fetching attribute, no inline",
    "event handler, and no off-site URL; each licence text is stored here, hashed, and carries the",
    "permission clause; and the files on disk, in this record, and in `corpus/manifest.json` are one",
    "set.",
    "",
    "**What it does not verify.** The original files are not kept here and are not fetched, so no",
    "check can compare a fixture with what it was reduced from, or re-run a scan against it. That",
    "these pages were not edited to make a rule agree is this project's statement, recorded per",
    "fixture in `selectedBecause` — each was chosen for the shape of its markup before anything was",
    "scanned — and the digests above are what stop one being changed afterwards.",
    "",
    "## Licence texts",
    "",
    "Stored verbatim from each source at the commit recorded above, and hashed in `provenance.json`",
    "so a truncated or substituted copy fails the build.",
    "",
    ...texts.flatMap((text) => [text, ""]),
    "## What these fixtures do and do not establish",
    "",
    "They establish that FairUX has been measured against licensed UI fragments **this project did",
    "not author**, in markup conventions it did not choose.",
    "",
    "They do **not** establish representativeness of live commercial websites. Design-system examples",
    "and component test pages are not drawn from the same distribution as a shipping checkout flow,",
    "and nothing measured here should be reported as if they were. Evaluating permissioned pages from",
    "production sites is separate work and is not what this corpus is.",
  ].join("\n")}\n`;
}

/**
 * Every way the third-party corpus can be wrong, as a list of failures.
 *
 * Takes the corpus directory so a test can point it at a temporary tree with one thing changed. The
 * negative cases in `tests/unit/third-party-fixtures-contract.test.ts` are each a bypass that used
 * to work or could.
 */
export function thirdPartyFixtureFailures(corpusDir) {
  const failures = [];
  const fail = (message) => failures.push(message);

  const provenancePath = join(corpusDir, "third-party/provenance.json");
  const manifestPath = join(corpusDir, "manifest.json");
  const noticePath = join(corpusDir, "third-party/THIRD_PARTY_NOTICE.md");
  const licenceDir = join(corpusDir, "third-party/licenses");

  if (!existsSync(provenancePath)) return [`${provenancePath} is missing`];
  const provenance = JSON.parse(readFileSync(provenancePath, "utf8"));
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

  /** Disk, provenance and manifest, as three sets that have to be the same one. */
  const onDisk = new Set(
    existsSync(join(corpusDir, "third-party"))
      ? readdirSync(join(corpusDir, "third-party"))
          .filter((entry) => entry.endsWith(".html"))
          .filter((entry) => statSync(join(corpusDir, "third-party", entry)).isFile())
          .map((entry) => `third-party/${entry}`)
      : [],
  );
  const inProvenance = new Set();
  const inManifest = new Map(
    manifest.cases
      .filter((entry) => entry.file.startsWith("third-party/"))
      .map((entry) => [entry.file, entry]),
  );

  const licenceTexts = new Map();
  const seenCaseIds = new Set();

  /** The sources, checked once each rather than once per fixture that cites them. */
  const sourceById = new Map();
  for (const source of provenance.sources ?? []) {
    const label = source.id ?? "<unnamed source>";
    for (const field of REQUIRED_SOURCE_FIELDS) {
      if (isEmpty(source[field])) fail(`${label}: source record has no ${field}`);
    }
    if (sourceById.has(source.id)) fail(`${label}: is declared twice`);
    sourceById.set(source.id, source);

    if (!ALLOWED_LICENCES.includes(source.licenseSpdx)) {
      fail(
        `${label}: licence ${JSON.stringify(source.licenseSpdx)} is not one of ${ALLOWED_LICENCES.join(", ")}`,
      );
    }
    if (!/^[0-9a-f]{40}$/.test(source.commit ?? "")) {
      fail(`${label}: commit is not a full 40-character SHA — a movable ref records nothing`);
    }

    // `licensePath` is where the stored text came from, and the notice prints it. A record that
    // omitted it would render "Taken from `undefined`" and still pass everything else.
    if (typeof source.licensePath === "string" && source.licensePath.includes("..")) {
      fail(`${label}: licensePath ${JSON.stringify(source.licensePath)} escapes its repository`);
    }

    const licenceName = source.licenseNoticeFile;
    if (typeof licenceName === "string" && licenceName.length > 0) {
      if (licenceName.includes("/") || licenceName.includes("\\") || licenceName.includes("..")) {
        fail(`${label}: licenseNoticeFile ${JSON.stringify(licenceName)} is not a bare file name`);
      } else if (!existsSync(join(licenceDir, licenceName))) {
        fail(`${label}: licence text licenses/${licenceName} is not stored here`);
      } else {
        const bytes = readFileSync(join(licenceDir, licenceName));
        if (bytes.length === 0) fail(`${label}: licence text licenses/${licenceName} is empty`);
        const digest = sha256(bytes);
        if (digest !== source.licenseNoticeSha256) {
          fail(
            `${label}: licence text licenses/${licenceName} is ${digest}, provenance records ${source.licenseNoticeSha256}`,
          );
        }
        const text = bytes.toString("utf8");
        if (!/permission is hereby granted/i.test(text)) {
          fail(
            `${label}: licence text licenses/${licenceName} carries no permission notice, which is the clause that has to travel with the copy`,
          );
        }
        licenceTexts.set(licenceName, text);
      }
    }
  }

  for (const fixture of provenance.fixtures) {
    const label = fixture.file ?? fixture.caseId ?? "<unnamed>";

    for (const field of REQUIRED_FIXTURE_FIELDS) {
      if (isEmpty(fixture[field])) fail(`${label}: provenance has no ${field}`);
    }
    if (fixture.sourceId !== undefined && !sourceById.has(fixture.sourceId)) {
      fail(`${label}: cites source ${JSON.stringify(fixture.sourceId)}, which is not declared`);
    }

    if (seenCaseIds.has(fixture.caseId))
      fail(`${label}: caseId ${fixture.caseId} is registered twice`);
    seenCaseIds.add(fixture.caseId);
    if (inProvenance.has(fixture.file)) fail(`${label}: is registered twice in provenance`);
    inProvenance.add(fixture.file);

    const pathProblem = fixturePathProblem(fixture.file, corpusDir);
    if (pathProblem) {
      fail(`${label}: ${pathProblem}`);
      continue;
    }

    const fixturePath = join(corpusDir, fixture.file);
    if (!existsSync(fixturePath)) {
      fail(`${label}: the fixture is recorded but not on disk`);
      continue;
    }

    const bytes = readFileSync(fixturePath);
    const digest = sha256(bytes);
    if (digest !== fixture.reducedSha256) {
      fail(`${label}: content is ${digest}, provenance records ${fixture.reducedSha256}`);
    }

    for (const problem of reductionProblems(bytes.toString("utf8"))) {
      fail(`${label}: still contains ${problem}`);
    }

    const registered = inManifest.get(fixture.file);
    if (!registered) {
      fail(`${label}: not registered in corpus/manifest.json, so nothing evaluates it`);
    } else if (registered.id !== fixture.caseId) {
      fail(
        `${label}: provenance calls it ${fixture.caseId}, the manifest calls it ${registered.id}`,
      );
    }
  }

  for (const file of onDisk) {
    if (!inProvenance.has(file)) {
      fail(`${file}: on disk with no provenance record — nothing says it may be redistributed`);
    }
  }
  for (const file of inProvenance) {
    if (!onDisk.has(file)) fail(`${file}: recorded in provenance but not in corpus/third-party/`);
  }
  for (const file of inManifest.keys()) {
    if (!inProvenance.has(file)) fail(`${file}: in the corpus manifest with no provenance record`);
  }

  if (failures.length === 0) {
    const expected = renderNotice(provenance, licenceTexts);
    const actual = existsSync(noticePath) ? readFileSync(noticePath, "utf8") : "";
    if (actual !== expected) {
      fail(
        "THIRD_PARTY_NOTICE.md disagrees with provenance.json and the stored licence texts — " +
          "regenerate it with `pnpm third-party:notice`",
      );
    }
  }

  return failures;
}
