/**
 * Read the SDK's publication state out of `docs/status.md`, as a record rather than as prose.
 *
 * The release preflight used to assert that the status document contained the words "has not been
 * published to npm". That was true exactly until the first release, and once `0.1.0-beta.2` was on
 * npm it forced this repository's stated source of truth to say something false.
 *
 * Replacing it with a search for either phrase was worse, because it read as a stronger check than
 * it was. Measured against the real document, both of these passed:
 *
 *   - the same "is published" sentence written twice — a boolean `includes()` cannot count;
 *   - a claim about `0.1.0-beta.1` while `0.1.0-beta.2` appeared in an unrelated roadmap line —
 *     nothing tied the version mention to the claim.
 *
 * So the state is a table row with one package spec and one word, and this parser refuses anything
 * that is not exactly that. It says nothing about the registry: what npm actually holds is the
 * registry reader's job. This only fixes what the document is allowed to say.
 *
 * Two source-level rules decide what counts, and neither claims more than it establishes.
 *
 * **Recognised opaque contexts are skipped.** A record inside a fenced code block — an example of
 * the format, in a document that documents the format — satisfied an earlier version, as did one
 * inside an HTML comment, an indented code block, or a `<pre>`, `<script>`, `<div>`, CDATA, or
 * declaration block. The scanner knows those contexts and refuses to read a record out of any of
 * them. Within those enumerated contexts an unclosed block keeps every later line skipped, so a
 * missing terminator cannot reopen what the block was holding — missing a real record fails the
 * release check loudly, while accepting a skipped one passes it silently. Syntax outside the
 * enumerated contexts is not interpreted as part of this contract.
 *
 * **The record itself sits at column zero.** Markdown allows a heading or a table row up to three
 * spaces of indent, and that allowance is indistinguishable from list-continuation indentation —
 * a record nested under a list item passed while being that list item's content rather than the
 * document's own statement. Rather than parse list nesting, this contract is narrower than Markdown:
 * the canonical heading and every row of its table must start in column zero. `docs/status.md`
 * already writes them that way.
 *
 * What this is not: a Markdown renderer, an HTML parser, or a check on what is visible in a browser
 * after CSS. It reads source, under rules stated here.
 */

export const SDK_PUBLICATION_HEADING = "### SDK publication state";
export const SDK_PUBLICATION_HEADER_ROW = Object.freeze(["Package version", "npm state"]);
export const SDK_PUBLICATION_STATES = Object.freeze(["published", "unpublished"]);

export class SdkPublicationStatusError extends Error {
  constructor(message) {
    super(message);
    this.name = "SdkPublicationStatusError";
  }
}

const RAW_TEXT_TAGS = ["script", "pre", "style", "textarea"];

/** Tracks `<!--` and `-->` across a line, in order, so a closed comment cannot mask an open one. */
function commentStateAfter(line, open) {
  let index = 0;
  let inComment = open;
  while (index < line.length) {
    if (inComment) {
      const close = line.indexOf("-->", index);
      if (close === -1) return true;
      index = close + 3;
      inComment = false;
    } else {
      const start = line.indexOf("<!--", index);
      if (start === -1) return false;
      index = start + 4;
      inComment = true;
    }
  }
  return inComment;
}

/**
 * Source lines that are not inside one of the opaque block contexts this scanner recognises, with
 * every other position replaced by `undefined`.
 *
 * Skipped: fenced code (backtick and tilde), indented code (four spaces or a tab), HTML comments,
 * the raw-text blocks `<script>`/`<pre>`/`<style>`/`<textarea>`, processing instructions,
 * declarations, CDATA, and any other HTML block until the blank line that ends it. A block left
 * unclosed skips everything after it.
 *
 * This is not a Markdown renderer, an HTML parser, or a visibility check, and a returned line is
 * not thereby proven to be anything in particular — list nesting is not analysed. The canonical
 * publication heading and table are constrained separately, by requiring column zero.
 *
 * @param {string} markdown
 * @returns {Array<string | undefined>}
 */
export function nonOpaqueMarkdownLines(markdown) {
  const lines = String(markdown).split(/\r?\n/);
  const visible = [];

  let fence;
  let inComment = false;
  /** A raw-text or bracketed block that ends on a closing string rather than a blank line. */
  let openBlock;
  /** An HTML block that ends at the next blank line. */
  let inHtmlBlock = false;

  for (const line of lines) {
    if (fence !== undefined) {
      const closing = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(line);
      if (closing && closing[1][0] === fence.marker && closing[1].length >= fence.length) {
        fence = undefined;
      }
      visible.push(undefined);
      continue;
    }

    if (inComment) {
      inComment = commentStateAfter(line, true);
      visible.push(undefined);
      continue;
    }

    if (openBlock !== undefined) {
      if (openBlock.test(line)) openBlock = undefined;
      visible.push(undefined);
      continue;
    }

    if (inHtmlBlock) {
      if (line.trim() === "") inHtmlBlock = false;
      visible.push(undefined);
      continue;
    }

    // Opening a fence.
    const opening = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (opening) {
      fence = { marker: opening[1][0], length: opening[1].length };
      visible.push(undefined);
      continue;
    }

    // Comments first: `<!--` also matches the declaration and CDATA prefixes below.
    if (line.includes("<!--")) {
      inComment = commentStateAfter(line, false);
      visible.push(undefined);
      continue;
    }

    // A raw-text block is closed by *its own* end tag and no other. One closer built from all four
    // tag names let `<script>` be closed by `</pre>`, which reopened everything the block was
    // hiding — including, in the case that found this, a publication record.
    const rawText = new RegExp(`^ {0,3}<(${RAW_TEXT_TAGS.join("|")})(?:[\\s>/]|$)`, "i").exec(line);
    if (rawText) {
      const closer = new RegExp(`</${rawText[1]}>`, "i");
      // Checked past the opening `<` so a one-line `<pre>…</pre>` closes here rather than
      // swallowing the rest of the document.
      if (!closer.test(line.slice(rawText[0].length))) openBlock = closer;
      visible.push(undefined);
      continue;
    }

    // Bracketed blocks whose closer is fixed rather than derived from the tag that opened them.
    const bracketed = [
      [/^ {0,3}<!\[CDATA\[/, /\]\]>/],
      [/^ {0,3}<\?/, /\?>/],
      [/^ {0,3}<![A-Za-z]/, />/],
    ];
    const bracketedMatch = bracketed.find(([opener]) => opener.test(line));
    if (bracketedMatch) {
      const closer = bracketedMatch[1];
      const openerLength = /^ {0,3}</.exec(line)?.[0].length ?? 0;
      if (!closer.test(line.slice(openerLength))) openBlock = closer;
      visible.push(undefined);
      continue;
    }

    // Any other HTML block: skipped until the blank line that ends it. Deliberately broad, since a
    // line opening with a tag is not one to read a record out of.
    if (/^ {0,3}<\/?[A-Za-z]/.test(line)) {
      inHtmlBlock = true;
      visible.push(undefined);
      continue;
    }

    // Indented code. Four spaces or a tab is a code block, and `line.trim()` used to erase exactly
    // that distinction before anything looked at the line.
    if (/^(?: {4,}|\t)/.test(line)) {
      visible.push(undefined);
      continue;
    }

    visible.push(line);
  }

  return visible;
}

/**
 * `| a | b |` → `["a", "b"]`, or undefined when the line is not a canonical table row.
 *
 * Column zero, for the same reason as the heading: an indented row is either code or a list item's
 * content, and this record is neither. Trailing whitespace is allowed — it changes nothing and
 * editors add it.
 */
function tableCells(line) {
  if (!line.startsWith("|")) return undefined;
  const trimmed = line.trimEnd();
  if (!trimmed.endsWith("|")) return undefined;
  return trimmed
    .slice(1, -1)
    .split("|")
    .map((cell) => cell.trim());
}

const isSeparatorRow = (cells) => cells.every((cell) => /^:?-{3,}:?$/.test(cell));

/**
 * @param {string} markdown  the contents of `docs/status.md`
 * @param {{packageName: string, version: string}} expected  from the SDK manifest
 * @returns {{packageSpec: string, state: "published" | "unpublished"}}
 */
export function readSdkPublicationStatus(markdown, { packageName, version }) {
  const lines = nonOpaqueMarkdownLines(markdown);
  const headings = [];
  for (const [index, line] of lines.entries()) {
    // Column zero exactly. Markdown would allow up to three spaces, but that allowance cannot be
    // told apart from a list item's continuation indent.
    if (line === SDK_PUBLICATION_HEADING) headings.push(index);
  }
  if (headings.length === 0) {
    throw new SdkPublicationStatusError(
      `status docs have no canonical column-zero "${SDK_PUBLICATION_HEADING}" section`,
    );
  }
  if (headings.length > 1) {
    // More than one table is the ambiguity this whole contract exists to remove: a reader — human
    // or otherwise — would have to decide which one counts.
    throw new SdkPublicationStatusError(
      `status docs have ${headings.length} "${SDK_PUBLICATION_HEADING}" sections; exactly one is allowed`,
    );
  }

  const rows = [];
  // The line each row came from, so the stray-table scan below can skip exactly this table rather
  // than a range guessed from the heading's position — blank lines and hidden regions inside the
  // section would make that arithmetic point at the wrong lines.
  const rowLines = new Set();
  for (let index = headings[0] + 1; index < lines.length; index += 1) {
    const line = lines[index];
    // A fenced or commented region inside the section ends the table rather than continuing it.
    if (line === undefined) {
      if (rows.length > 0) break;
      continue;
    }
    const cells = tableCells(line);
    if (cells === undefined) {
      if (rows.length > 0) break;
      if (line.trim() === "") continue;
      throw new SdkPublicationStatusError(
        `status docs put "${line.trim()}" where the publication table should start`,
      );
    }
    rows.push(cells);
    rowLines.add(index);
  }

  // A second table with the same header, outside the canonical section, is the same ambiguity as a
  // second heading: hidden examples are excluded above, so anything left is visible to a reader.
  const strays = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (rowLines.has(index)) continue;
    const cells = tableCells(lines[index] ?? "");
    if (cells && cells.length === SDK_PUBLICATION_HEADER_ROW.length) {
      if (cells.every((cell, position) => cell === SDK_PUBLICATION_HEADER_ROW[position])) {
        strays.push(index + 1);
      }
    }
  }
  if (strays.length > 0) {
    throw new SdkPublicationStatusError(
      `status docs have another publication table outside the "${SDK_PUBLICATION_HEADING}" section, at line ${strays[0]}`,
    );
  }

  const [header, separator, ...body] = rows;
  if (header === undefined || separator === undefined) {
    throw new SdkPublicationStatusError("status docs have no publication table under the heading");
  }
  if (
    header.length !== SDK_PUBLICATION_HEADER_ROW.length ||
    !header.every((cell, position) => cell === SDK_PUBLICATION_HEADER_ROW[position])
  ) {
    throw new SdkPublicationStatusError(
      `publication table header must be ${JSON.stringify(SDK_PUBLICATION_HEADER_ROW)}, got ${JSON.stringify(header)}`,
    );
  }
  if (separator.length !== header.length) {
    // A separator that does not match the header is not a table this parser can read one record
    // out of, whatever a renderer decides to do with it.
    throw new SdkPublicationStatusError(
      `publication table separator has ${separator.length} columns, but the header has ${header.length}`,
    );
  }
  if (!isSeparatorRow(separator)) {
    throw new SdkPublicationStatusError("publication table is missing its separator row");
  }
  if (body.length !== 1) {
    // Two identical rows are as wrong as two contradicting ones: the document would be asserting a
    // fact twice, and a later edit could change one of them.
    throw new SdkPublicationStatusError(
      `publication table must hold exactly one record, got ${body.length}`,
    );
  }

  const [record] = body;
  if (record.length !== 2) {
    throw new SdkPublicationStatusError(
      `publication record must have 2 cells, got ${record.length}`,
    );
  }
  const specCell = record[0];
  const stateCell = record[1];

  const specMatch = /^`([^`]+)`$/.exec(specCell);
  if (!specMatch) {
    throw new SdkPublicationStatusError(
      `publication record's package version must be a backticked spec, got ${JSON.stringify(specCell)}`,
    );
  }
  const expectedSpec = `${packageName}@${version}`;
  if (specMatch[1] !== expectedSpec) {
    // The defect this replaces: a claim about another version passed as long as the released
    // version appeared somewhere else in the document.
    throw new SdkPublicationStatusError(
      `publication record is for ${specMatch[1]}, but the SDK manifest is at ${expectedSpec}`,
    );
  }

  const stateMatch = /^\*\*([a-z]+)\*\*$/.exec(stateCell);
  if (!stateMatch || !SDK_PUBLICATION_STATES.includes(stateMatch[1])) {
    throw new SdkPublicationStatusError(
      `publication state must be one of ${SDK_PUBLICATION_STATES.map((state) => `**${state}**`).join(" or ")}, got ${JSON.stringify(stateCell)}`,
    );
  }

  return { packageSpec: expectedSpec, state: stateMatch[1] };
}
