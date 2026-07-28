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
 */

export const SDK_PUBLICATION_HEADING = "### SDK publication state";
export const SDK_PUBLICATION_HEADER_ROW = ["Package version", "npm state"];
export const SDK_PUBLICATION_STATES = Object.freeze(["published", "unpublished"]);

export class SdkPublicationStatusError extends Error {
  constructor(message) {
    super(message);
    this.name = "SdkPublicationStatusError";
  }
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
  const lines = String(markdown).split(/\r?\n/);
  const headings = [];
  for (const [index, line] of lines.entries()) {
    if (line.trim() === SDK_PUBLICATION_HEADING) headings.push(index);
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
    const cells = tableCells(lines[index]);
    if (cells === undefined) {
      if (rows.length > 0) break;
      if (lines[index].trim() === "") continue;
      throw new SdkPublicationStatusError(
        `status docs put "${lines[index].trim()}" where the publication table should start`,
      );
    }
    rows.push(cells);
  }

  const [header, separator, ...body] = rows;
  if (header === undefined || separator === undefined) {
    throw new SdkPublicationStatusError("status docs have no publication table under the heading");
  }
  if (header.length !== 2 || header[0] !== "Package version" || header[1] !== "npm state") {
    throw new SdkPublicationStatusError(
      `publication table header must be ${JSON.stringify(SDK_PUBLICATION_HEADER_ROW)}, got ${JSON.stringify(header)}`,
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
