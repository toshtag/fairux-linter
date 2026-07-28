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
const RAW_TEXT_TAG_NAMES = ["script", "pre", "style", "textarea"] as const;

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
      /no canonical column-zero "### SDK publication state" section/,
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

describe("SDK publication status — the opaque contexts the scanner skips", () => {
  const section = [
    "### SDK publication state",
    "",
    "| Package version | npm state |",
    "| --- | --- |",
    `| \`${PACKAGE}@${VERSION}\` | **published** |`,
  ].join("\n");

  const page = (...blocks: string[]) => ["# FairUX status", "", ...blocks, ""].join("\n");

  it("does not count a record that only exists inside a fenced example", () => {
    // The document documents this format, so an example of it is exactly what would sit in a fence.
    // Reading raw lines let that example satisfy the release check, with no publication record
    // outside the fence at all.
    expect(() => readSdkPublicationStatus(page("```md", section, "```"), EXPECTED)).toThrow(
      /no canonical column-zero "### SDK publication state" section/,
    );
  });

  it("does not count a tilde-fenced example either", () => {
    expect(() => readSdkPublicationStatus(page("~~~md", section, "~~~"), EXPECTED)).toThrow(
      /no canonical column-zero "### SDK publication state" section/,
    );
  });

  it("does not count a record inside an HTML comment", () => {
    expect(() => readSdkPublicationStatus(page("<!--", section, "-->"), EXPECTED)).toThrow(
      /no canonical column-zero "### SDK publication state" section/,
    );
  });

  it("treats an unclosed fence as hiding everything after it", () => {
    // What a renderer does with it. A record after an unterminated fence is not visible.
    expect(() => readSdkPublicationStatus(page("```md", section), EXPECTED)).toThrow(
      /no canonical column-zero "### SDK publication state" section/,
    );
  });

  it("treats an unclosed HTML comment the same way", () => {
    expect(() => readSdkPublicationStatus(page("<!--", section), EXPECTED)).toThrow(
      /no canonical column-zero "### SDK publication state" section/,
    );
  });

  it("reads the live record when a fenced example sits beside it", () => {
    // The case that has to keep working: a document may show the format and also state it.
    expect(readSdkPublicationStatus(page(section, "", "```md", section, "```"), EXPECTED)).toEqual({
      packageSpec: `${PACKAGE}@${VERSION}`,
      state: "published",
    });
  });

  it("reads the live record when a commented example sits beside it", () => {
    expect(readSdkPublicationStatus(page(section, "", "<!--", section, "-->"), EXPECTED)).toEqual({
      packageSpec: `${PACKAGE}@${VERSION}`,
      state: "published",
    });
  });

  it("refuses a second live publication table outside the section", () => {
    // Two visible tables are ambiguous to a reader as much as to this parser, even where only one
    // sits under the canonical heading.
    const stray = [
      "Elsewhere:",
      "",
      "| Package version | npm state |",
      "| --- | --- |",
      `| \`${PACKAGE}@${VERSION}\` | **unpublished** |`,
    ].join("\n");

    expect(() => readSdkPublicationStatus(page(section, "", stray), EXPECTED)).toThrow(
      /another publication table outside/,
    );
  });
});

describe("SDK publication status — the table's shape", () => {
  const withSeparator = (separator: string) =>
    [
      "### SDK publication state",
      "",
      "| Package version | npm state |",
      separator,
      `| \`${PACKAGE}@${VERSION}\` | **published** |`,
    ].join("\n");

  it("refuses a separator with more columns than the header", () => {
    expect(() => readSdkPublicationStatus(withSeparator("| --- | --- | --- |"), EXPECTED)).toThrow(
      /separator has 3 columns, but the header has 2/,
    );
  });

  it("refuses a separator with fewer columns than the header", () => {
    expect(() => readSdkPublicationStatus(withSeparator("| --- |"), EXPECTED)).toThrow(
      /separator has 1 columns, but the header has 2/,
    );
  });

  it("accepts the aligned separator forms Markdown allows", () => {
    for (const separator of ["| --- | --- |", "| :--- | ---: |", "| :---: | :---: |"]) {
      expect(readSdkPublicationStatus(withSeparator(separator), EXPECTED)).toMatchObject({
        state: "published",
      });
    }
  });
});

describe("SDK publication status — the opaque source contexts the scanner recognises", () => {
  const rows = [
    "### SDK publication state",
    "",
    "| Package version | npm state |",
    "| --- | --- |",
    `| \`${PACKAGE}@${VERSION}\` | **published** |`,
  ];
  const live = rows.join("\n");
  /** The same record with no blank line, so an HTML block cannot be ended by one mid-example. */
  const compact = rows.filter(Boolean).join("\n");
  const indented = (prefix: string) => rows.map((line) => (line ? prefix + line : line)).join("\n");
  const page = (...blocks: string[]) => ["# FairUX status", "", ...blocks, ""].join("\n");

  const hidden: Array<[string, string]> = [
    ["four-space indented code", indented("    ")],
    ["tab-indented code", indented("\t")],
    ["a <pre> block", `<pre>\n${live}\n</pre>`],
    ["a <script> block", `<script>\n${live}\n</script>`],
    ["a <style> block", `<style>\n${live}\n</style>`],
    ["a <textarea> block", `<textarea>\n${live}\n</textarea>`],
    ["an HTML block", `<div>\n${compact}\n</div>`],
    ["a processing instruction", `<?php\n${live}\n?>`],
    ["a declaration", `<!DOCTYPE html\n${live}\n>`],
    ["a CDATA section", `<![CDATA[\n${live}\n]]>`],
    ["an unclosed <pre> block", `<pre>\n${live}`],
    ["an unclosed CDATA section", `<![CDATA[\n${live}`],
  ];

  it.each(hidden)("does not read a record out of %s", (_label, block) => {
    // Each of these renders as text, not as a heading and a table. `line.trim()` erased the indent
    // distinction outright, and nothing knew about raw HTML at all.
    expect(() => readSdkPublicationStatus(page(block), EXPECTED)).toThrow(
      SdkPublicationStatusError,
    );
  });

  it.each(hidden)("still reads the live record beside %s", (_label, block) => {
    expect(readSdkPublicationStatus(page(live, "", block), EXPECTED)).toEqual({
      packageSpec: `${PACKAGE}@${VERSION}`,
      state: "published",
    });
  });

  it("ends an HTML block at the blank line, per the CommonMark block boundary", () => {
    // Not a loophole: CommonMark ends a `<div>` block at the first blank line, so the table after
    // one is outside the block by this source contract's rules — what a browser shows after HTML
    // parsing and CSS is a separate question this makes no claim about. The heading before the
    // blank line is inside, which is why there is no section here at all.
    expect(() => readSdkPublicationStatus(page(`<div>\n${live}\n</div>`), EXPECTED)).toThrow(
      /no canonical column-zero "### SDK publication state" section/,
    );
  });
});

describe("SDK publication status — HTML comment boundaries", () => {
  const rows = [
    "### SDK publication state",
    "",
    "| Package version | npm state |",
    "| --- | --- |",
    `| \`${PACKAGE}@${VERSION}\` | **published** |`,
  ];
  const live = rows.join("\n");
  const page = (...blocks: string[]) => ["# FairUX status", "", ...blocks, ""].join("\n");

  it("keeps the comment open when a closed one precedes an unclosed one on the same line", () => {
    // The previous scanner took any `-->` on the line as closing, so the second opener was lost and
    // everything after it read as live.
    expect(() => readSdkPublicationStatus(page(`<!-- closed --> <!--\n${live}`), EXPECTED)).toThrow(
      /no canonical column-zero "### SDK publication state" section/,
    );
  });

  it("reads the live record after comments that all close", () => {
    expect(
      readSdkPublicationStatus(page("<!-- a --> <!-- b -->", "", live), EXPECTED),
    ).toMatchObject({ state: "published" });
  });

  it("does not let a fence marker inside a comment change the scanner's state", () => {
    expect(readSdkPublicationStatus(page("<!--", "```", "-->", "", live), EXPECTED)).toMatchObject({
      state: "published",
    });
  });
});

describe("SDK publication status — the record sits at column zero", () => {
  const rows = [
    "### SDK publication state",
    "",
    "| Package version | npm state |",
    "| --- | --- |",
    `| \`${PACKAGE}@${VERSION}\` | **published** |`,
  ];
  const live = rows.join("\n");
  const indent = (prefix: string) => rows.map((line) => (line ? prefix + line : line)).join("\n");
  const page = (...blocks: string[]) => ["# FairUX status", "", ...blocks, ""].join("\n");

  it.each([
    ["one space", " "],
    ["two spaces", "  "],
    ["three spaces", "   "],
  ])("refuses a record indented by %s", (_label, prefix) => {
    // Markdown allows a heading or a table row up to three spaces in, and that allowance is
    // indistinguishable from list-continuation indent. This contract is narrower than Markdown
    // rather than parsing list nesting to tell them apart.
    expect(() => readSdkPublicationStatus(page(indent(prefix)), EXPECTED)).toThrow(
      /no canonical column-zero "### SDK publication state" section/,
    );
  });

  it("refuses a record nested under a list item", () => {
    // Visible, and not the document's own statement — it is that list item's content.
    expect(() =>
      readSdkPublicationStatus(page("- Release metadata", "", indent("  ")), EXPECTED),
    ).toThrow(/no canonical column-zero/);
  });

  it("reads the column-zero record beside a list-nested example", () => {
    expect(
      readSdkPublicationStatus(page(live, "", "- Example", "", indent("  ")), EXPECTED),
    ).toEqual({ packageSpec: `${PACKAGE}@${VERSION}`, state: "published" });
  });

  it("tolerates trailing whitespace on the table rows", () => {
    // Leading whitespace changes which block a row belongs to; trailing whitespace changes nothing
    // and editors add it.
    const padded = rows.map((line) => (line.startsWith("|") ? `${line}  ` : line)).join("\n");

    expect(readSdkPublicationStatus(page(padded), EXPECTED)).toMatchObject({ state: "published" });
  });
});

describe("SDK publication status — a raw-text block closes on its own end tag", () => {
  const record = [
    "### SDK publication state",
    "| Package version | npm state |",
    "| --- | --- |",
    `| \`${PACKAGE}@${VERSION}\` | **published** |`,
  ].join("\n");
  const page = (...blocks: string[]) => ["# FairUX status", "", ...blocks, ""].join("\n");

  const mismatched: Array<[string, string]> = [
    ["script", "pre"],
    ["pre", "style"],
    ["style", "textarea"],
    ["textarea", "script"],
  ];

  it.each(mismatched)("keeps a <%s> block open through a stray </%s>", (open, wrong) => {
    // One closer built from all four tag names let any of them end any block, which reopened
    // everything the block was hiding — here, a publication record.
    expect(() =>
      readSdkPublicationStatus(
        page(`<${open}>`, "text", `</${wrong}>`, record, `</${open}>`),
        EXPECTED,
      ),
    ).toThrow(/no canonical column-zero/);
  });

  it("keeps the block open when the wrong closer is on the opening line", () => {
    expect(() =>
      readSdkPublicationStatus(page("<script></pre>", record, "</script>"), EXPECTED),
    ).toThrow(/no canonical column-zero/);
  });

  it.each(RAW_TEXT_TAG_NAMES)("reads a record after a matching </%s>", (tag) => {
    expect(
      readSdkPublicationStatus(page(`<${tag}>`, "text", `</${tag}>`, "", record), EXPECTED),
    ).toMatchObject({ state: "published" });
  });

  it("closes a one-line raw-text block on the line that opened it", () => {
    expect(readSdkPublicationStatus(page("<pre>text</pre>", "", record), EXPECTED)).toMatchObject({
      state: "published",
    });
  });
});
