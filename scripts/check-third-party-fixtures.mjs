#!/usr/bin/env node
/**
 * Every corpus fixture this project did not write is licensed, attributed, and unmodified.
 *
 * The decisions are in `third-party-fixtures-contract.mjs`, so they can be exercised against a
 * temporary tree rather than only against the one tree that happens to pass. This file prints and
 * exits, and `--write` regenerates `THIRD_PARTY_NOTICE.md` from `provenance.json` and the stored
 * licence texts.
 *
 * It fails the build rather than reporting. A fixture whose provenance goes missing is a licence
 * problem, not a stale comment, and there is deliberately no allowlist: a fixture that cannot
 * satisfy this does not belong in the corpus.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { renderNotice, thirdPartyFixtureFailures } from "./third-party-fixtures-contract.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CORPUS = join(ROOT, "corpus");
const NOTICE = join(CORPUS, "third-party/THIRD_PARTY_NOTICE.md");

if (process.argv.includes("--write")) {
  const provenance = JSON.parse(readFileSync(join(CORPUS, "third-party/provenance.json"), "utf8"));
  const texts = new Map(
    provenance.sources
      .map((source) => source.licenseNoticeFile)
      .filter((name) => existsSync(join(CORPUS, "third-party/licenses", name)))
      .map((name) => [name, readFileSync(join(CORPUS, "third-party/licenses", name), "utf8")]),
  );
  writeFileSync(NOTICE, renderNotice(provenance, texts));
  console.log(`✓ wrote ${NOTICE}`);
}

const failures = thirdPartyFixtureFailures(CORPUS);

if (failures.length > 0) {
  console.error("✖ Third-party corpus fixtures:\n");
  for (const failure of failures) console.error(`  ${failure}`);
  console.error(
    "\nThese pages are here because their licences allow it. Fix the record, or remove the fixture —\n" +
      "there is deliberately no way to exempt one.",
  );
  process.exit(1);
}

const provenance = JSON.parse(readFileSync(join(CORPUS, "third-party/provenance.json"), "utf8"));
console.log(
  `✓ ${provenance.fixtures.length} third-party fixtures from ${provenance.sources.length} sources: ` +
    "licensed with their permission notices, attributed, reduced, and pinned by digest",
);
