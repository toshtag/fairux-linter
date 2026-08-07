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
 * Provenance fields without which a fixture is not attributable.
 *
 * `sourceUrl` used to be here and was the whole of `sourceRepository/blob/sourceCommit/sourcePath`,
 * checked only for containing the commit — a stored derivation whose one guarantee was that it
 * matched the three fields it was derived from. The notice builds its links from those three.
 *
 * `selectedBecause` is required for a reason the others are not: it is the record that a fixture was
 * chosen for the shape of its markup **before** anything was scanned. Without it, a corpus that had
 * quietly kept the pages a rule happened to agree with would look the same as this one.
 */
export const REQUIRED_FIELDS = Object.freeze([
  "caseId",
  "file",
  "sourceRepository",
  "sourceCommit",
  "sourcePath",
  "licenseSpdx",
  "licenseNoticeFile",
  "licenseNoticeSha256",
  "copyrightHolder",
  "capturedAt",
  "originalSha256",
  "reducedSha256",
  "reductionNotes",
  "selectedBecause",
]);

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
  const rows = provenance.fixtures.map((fixture) => {
    const repository = fixture.sourceRepository.split("/").pop();
    return (
      `| \`${fixture.file.split("/").pop()}\` | [${repository}](${fixture.sourceRepository}) | ` +
      `\`${fixture.sourceCommit.slice(0, 8)}\` | \`${fixture.sourcePath}\` | ` +
      `${fixture.licenseSpdx} | ${fixture.copyrightHolder} |`
    );
  });

  const sources = [];
  for (const fixture of provenance.fixtures) {
    if (sources.some((entry) => entry.repository === fixture.sourceRepository)) continue;
    sources.push({
      repository: fixture.sourceRepository,
      licence: fixture.licenseSpdx,
      holder: fixture.copyrightHolder,
      noticeFile: fixture.licenseNoticeFile,
      licensePath: fixture.licensePath,
      commit: fixture.sourceCommit,
    });
  }

  const texts = sources.map((source) => {
    const text = licenceTexts.get(source.noticeFile);
    const body = text
      .trimEnd()
      .split("\n")
      .map((line) => (line.length > 0 ? `> ${line}` : ">"))
      .join("\n");
    // A licence file with no copyright line is upstream's, not ours to correct. Saying which of the
    // two the holder came from is the difference between quoting and asserting.
    const attribution = /copyright/i.test(text)
      ? `${source.licence}, copyright ${source.holder} as stated in the licence text below.`
      : `${source.licence}. The licence text below names no copyright holder; ${source.holder} is ` +
        "taken from the source's `package.json` at the same commit and is recorded as an inference.";
    return [
      `### ${source.repository.split("/").pop()}`,
      "",
      attribution,
      "",
      `Taken from \`${source.licensePath}\` at \`${source.commit}\` and stored here as`,
      `[\`licenses/${source.noticeFile}\`](licenses/${source.noticeFile}).`,
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
    "**None of them was modified to make a rule fire.** `modifiedForDetection` is false for every",
    "fixture and the check refuses any other value, and each was scanned before and after reduction",
    "with the same rule ids reported.",
    "",
    "| Fixture | Source | Commit | Original path | Licence | Copyright |",
    "| --- | --- | --- | --- | --- | --- |",
    ...rows,
    "",
    "## What was removed",
    "",
    ...provenance.reduction.rules.map((rule) => `- ${rule}`),
    "",
    "Applied by `parse5` — the parser `@fairux/html` reads pages with — and never by hand. What is",
    "kept is what a rule reads: the parent and sibling relationships between controls, labels and",
    "their inputs, headings, button and link text, `role`, `aria-*`, `hidden`, `disabled`, `checked`,",
    "and the text next to a control. No analytics, no tracking pixel, no font, no external image, no",
    "API endpoint, no session identifier, no personal data, and no order number — none of them",
    "contained any of those before reduction either.",
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

  for (const fixture of provenance.fixtures) {
    const label = fixture.file ?? fixture.caseId ?? "<unnamed>";

    for (const field of REQUIRED_FIELDS) {
      const value = fixture[field];
      if (
        value === undefined ||
        value === null ||
        value === "" ||
        (Array.isArray(value) && value.length === 0)
      ) {
        fail(`${label}: provenance has no ${field}`);
      }
    }

    if (!ALLOWED_LICENCES.includes(fixture.licenseSpdx)) {
      fail(
        `${label}: licence ${JSON.stringify(fixture.licenseSpdx)} is not one of ${ALLOWED_LICENCES.join(", ")}`,
      );
    }
    if (!/^[0-9a-f]{40}$/.test(fixture.sourceCommit ?? "")) {
      fail(`${label}: sourceCommit is not a full 40-character SHA — a movable ref records nothing`);
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fixture.capturedAt ?? "")) {
      fail(`${label}: capturedAt is not a YYYY-MM-DD date`);
    }
    if (fixture.modifiedForDetection !== false) {
      fail(
        `${label}: modifiedForDetection must be false — a fixture edited to make a rule agree measures itself`,
      );
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

    const licenceName = fixture.licenseNoticeFile;
    if (typeof licenceName === "string" && licenceName.length > 0) {
      if (licenceName.includes("/") || licenceName.includes("\\") || licenceName.includes("..")) {
        fail(`${label}: licenseNoticeFile ${JSON.stringify(licenceName)} is not a bare file name`);
      } else if (!existsSync(join(licenceDir, licenceName))) {
        fail(`${label}: licence text licenses/${licenceName} is not stored here`);
      } else {
        const bytes = readFileSync(join(licenceDir, licenceName));
        if (bytes.length === 0) fail(`${label}: licence text licenses/${licenceName} is empty`);
        const digest = sha256(bytes);
        if (digest !== fixture.licenseNoticeSha256) {
          fail(
            `${label}: licence text licenses/${licenceName} is ${digest}, provenance records ${fixture.licenseNoticeSha256}`,
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
