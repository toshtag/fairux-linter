import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  readSdkPublicationStatus,
  SDK_PUBLICATION_STATES,
  SdkPublicationStatusError,
} from "../scripts/sdk-publication-status.mjs";

/**
 * The release preflight's status-document check was wrong twice, in opposite directions, and the
 * second time it read as a stronger check than it was — it was named "exactly one publication
 * claim" while asserting two booleans over the whole file. These cases exist so the third form
 * cannot quietly become the fourth: every way the earlier ones passed is a test here, not a
 * mutation someone ran once by hand.
 */

const PACKAGE = "@fairux/sdk";
const VERSION = "0.1.0-beta.2";
const EXPECTED = { packageName: PACKAGE, version: VERSION };

const doc = (...body: string[]) =>
  [
    "# FairUX status",
    "",
    "## Published beta",
    "",
    "### SDK publication state",
    "",
    ...body,
    "",
    "Prose after the table.",
    "",
  ].join("\n");

const table = (...records: string[]) => [
  "| Package version | npm state |",
  "| --- | --- |",
  ...records,
];

const record = (spec: string, state: string) => `| \`${spec}\` | **${state}** |`;

describe("SDK publication status — the record", () => {
  it("reads a published record for the exact version", () => {
    const status = readSdkPublicationStatus(
      doc(...table(record(`${PACKAGE}@${VERSION}`, "published"))),
      EXPECTED,
    );

    expect(status).toEqual({ packageSpec: `${PACKAGE}@${VERSION}`, state: "published" });
  });

  it("reads an unpublished record for the exact version", () => {
    // The state a version being prepared for its first publish carries. Both words have to be
    // readable, or the document goes back to being unable to tell the truth in one direction.
    const status = readSdkPublicationStatus(
      doc(...table(record(`${PACKAGE}@0.1.0-beta.3`, "unpublished"))),
      { packageName: PACKAGE, version: "0.1.0-beta.3" },
    );

    expect(status).toEqual({ packageSpec: `${PACKAGE}@0.1.0-beta.3`, state: "unpublished" });
    expect(SDK_PUBLICATION_STATES).toEqual(["published", "unpublished"]);
  });
});

describe("SDK publication status — what the earlier checks let through", () => {
  it("rejects the same claim written twice", () => {
    // A boolean `includes()` cannot count. Two identical rows passed the previous check.
    expect(() =>
      readSdkPublicationStatus(
        doc(
          ...table(
            record(`${PACKAGE}@${VERSION}`, "published"),
            record(`${PACKAGE}@${VERSION}`, "published"),
          ),
        ),
        EXPECTED,
      ),
    ).toThrow(/exactly one record, got 2/);
  });

  it("rejects a claim about another version while this one appears in the prose", () => {
    // The sharper miss: nothing tied the version mention to the claim, so a `0.1.0-beta.1`
    // publication line passed as long as `0.1.0-beta.2` appeared in an unrelated roadmap entry.
    const markdown = [
      doc(...table(record(`${PACKAGE}@0.1.0-beta.1`, "published"))),
      `Roadmap: ${PACKAGE}@${VERSION} is next.`,
    ].join("\n");

    expect(() => readSdkPublicationStatus(markdown, EXPECTED)).toThrow(
      new RegExp(`record is for ${PACKAGE}@0\\.1\\.0-beta\\.1`),
    );
  });

  it("rejects contradicting states", () => {
    expect(() =>
      readSdkPublicationStatus(
        doc(
          ...table(
            record(`${PACKAGE}@${VERSION}`, "published"),
            record(`${PACKAGE}@${VERSION}`, "unpublished"),
          ),
        ),
        EXPECTED,
      ),
    ).toThrow(/exactly one record, got 2/);
  });

  it("does not count the old literal prose as a record", () => {
    // "has not been published to npm" was the whole check once. It is prose now, and prose is not
    // a record.
    const markdown = [
      "# FairUX status",
      "",
      `${PACKAGE}@${VERSION} has not been published to npm.`,
    ].join("\n");

    expect(() => readSdkPublicationStatus(markdown, EXPECTED)).toThrow(
      /no "### SDK publication state" section/,
    );
  });
});

describe("SDK publication status — everything else it refuses", () => {
  it("rejects a document with no publication section", () => {
    expect(() => readSdkPublicationStatus("# FairUX status\n", EXPECTED)).toThrow(
      SdkPublicationStatusError,
    );
  });

  it("rejects more than one publication section", () => {
    const markdown = [
      doc(...table(record(`${PACKAGE}@${VERSION}`, "published"))),
      doc(...table(record(`${PACKAGE}@${VERSION}`, "unpublished"))),
    ].join("\n");

    expect(() => readSdkPublicationStatus(markdown, EXPECTED)).toThrow(/2 ".*" sections/);
  });

  it("rejects a section with no table", () => {
    expect(() => readSdkPublicationStatus(doc("Nothing here."), EXPECTED)).toThrow(
      /where the publication table should start/,
    );
  });

  it("rejects a header the reader does not recognise", () => {
    expect(() =>
      readSdkPublicationStatus(
        doc("| Version | State |", "| --- | --- |", record(`${PACKAGE}@${VERSION}`, "published")),
        EXPECTED,
      ),
    ).toThrow(/header must be/);
  });

  it("rejects a table with no separator row", () => {
    expect(() =>
      readSdkPublicationStatus(
        doc("| Package version | npm state |", record(`${PACKAGE}@${VERSION}`, "published")),
        EXPECTED,
      ),
    ).toThrow(/separator row/);
  });

  it("rejects a record with no rows", () => {
    expect(() => readSdkPublicationStatus(doc(...table()), EXPECTED)).toThrow(
      /exactly one record, got 0/,
    );
  });

  it("rejects another package", () => {
    expect(() =>
      readSdkPublicationStatus(doc(...table(record(`@fairux/core@${VERSION}`, "published"))), {
        packageName: PACKAGE,
        version: VERSION,
      }),
    ).toThrow(/record is for @fairux\/core/);
  });

  it("rejects a spec that is not backticked", () => {
    expect(() =>
      readSdkPublicationStatus(
        doc(
          "| Package version | npm state |",
          "| --- | --- |",
          `| ${PACKAGE}@${VERSION} | **published** |`,
        ),
        EXPECTED,
      ),
    ).toThrow(/must be a backticked spec/);
  });

  it("rejects a state it does not know", () => {
    for (const state of ["pending", "PUBLISHED", "published-ish"]) {
      expect(() =>
        readSdkPublicationStatus(doc(...table(record(`${PACKAGE}@${VERSION}`, state))), EXPECTED),
      ).toThrow(/publication state must be/);
    }
  });

  it("rejects a state that is not emphasised", () => {
    // The emphasis is what makes the state a value rather than a word in a sentence.
    expect(() =>
      readSdkPublicationStatus(
        doc(
          "| Package version | npm state |",
          "| --- | --- |",
          `| \`${PACKAGE}@${VERSION}\` | published |`,
        ),
        EXPECTED,
      ),
    ).toThrow(/publication state must be/);
  });
});

describe("SDK publication status — the real document", () => {
  const root = resolve(import.meta.dirname, "../../..");

  it("matches the SDK manifest this repository ships", () => {
    // The integration case: whatever the fixtures prove, the shipped document and the shipped
    // manifest have to agree, or `pnpm release:check:sdk` fails for a reason no fixture models.
    const manifest = JSON.parse(
      readFileSync(resolve(root, "packages/sdk/package.json"), "utf8"),
    ) as { name: string; version: string };
    const status = readFileSync(resolve(root, "docs/status.md"), "utf8");

    expect(
      readSdkPublicationStatus(status, {
        packageName: manifest.name,
        version: manifest.version,
      }),
    ).toEqual({ packageSpec: `${manifest.name}@${manifest.version}`, state: "published" });
  });
});
