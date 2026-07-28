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
 * It reads the *rendered* document, not the file's lines. Scanning raw text let a record inside a
 * fenced code block — an example of the format, in a document that documents the format — or inside
 * an HTML comment satisfy the check while nothing at all appeared to a reader. A record nobody can
 * see is not a record.
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

/**
 * The lines a reader would see, with every other position replaced by `undefined`.
 *
 * Fenced blocks and HTML comments are the two ways this document hides text from its rendered form,
 * and both hold examples of exactly the table this parser looks for. An unclosed fence or comment
 * hides everything after it — that is what a renderer does, so it is what this does.
 *
 * CommonMark's fence rules, only as far as they matter here: three or more backticks or tildes, up
 * to three leading spaces, closed by at least as many of the same character with no info string.
 *
 * @param {string} markdown
 * @returns {Array<string | undefined>}
 */
export function visibleMarkdownLines(markdown) {
  const lines = String(markdown).split(/\r?\n/);
  const visible = [];
  let fence;
  let inComment = false;

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
      if (line.includes("-->")) inComment = false;
      visible.push(undefined);
      continue;
    }

    const opening = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (opening) {
      fence = { marker: opening[1][0], length: opening[1].length };
      visible.push(undefined);
      continue;
    }

    // A comment that opens and closes on one line hides only itself; one that stays open hides
    // everything until it closes.
    if (line.includes("<!--")) {
      if (!line.slice(line.indexOf("<!--")).includes("-->")) inComment = true;
      visible.push(undefined);
      continue;
    }

    visible.push(line);
  }

  return visible;
}

/** `| a | b |` → `["a", "b"]`, or undefined when the line is not a table row. */
function tableCells(line) {
  const trimmed = line.trim();
  if (!trimmed.startsWith("|") || !trimmed.endsWith("|")) return undefined;
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
  const lines = visibleMarkdownLines(markdown);
  const headings = [];
  for (const [index, line] of lines.entries()) {
    if (line?.trim() === SDK_PUBLICATION_HEADING) headings.push(index);
  }
  if (headings.length === 0) {
    throw new SdkPublicationStatusError(`status docs have no "${SDK_PUBLICATION_HEADING}" section`);
  }
  if (headings.length > 1) {
    // More than one table is the ambiguity this whole contract exists to remove: a reader — human
    // or otherwise — would have to decide which one counts.
    throw new SdkPublicationStatusError(
      `status docs have ${headings.length} "${SDK_PUBLICATION_HEADING}" sections; exactly one is allowed`,
    );
  }

  const rows = [];
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
  }

  // A second table with the same header, outside the canonical section, is the same ambiguity as a
  // second heading: hidden examples are excluded above, so anything left is visible to a reader.
  const strays = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (index > headings[0] && index <= headings[0] + rows.length + 1) continue;
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
