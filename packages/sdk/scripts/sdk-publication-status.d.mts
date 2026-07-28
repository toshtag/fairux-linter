export declare const SDK_PUBLICATION_HEADING: "### SDK publication state";
export declare const SDK_PUBLICATION_HEADER_ROW: readonly string[];
export declare const SDK_PUBLICATION_STATES: readonly ["published", "unpublished"];

export type SdkPublicationState = (typeof SDK_PUBLICATION_STATES)[number];

export declare class SdkPublicationStatusError extends Error {
  readonly name: "SdkPublicationStatusError";
}

/**
 * The document's top-level Markdown lines, with every other position replaced by `undefined`.
 *
 * A conservative scanner, not a renderer: it excludes fenced code, indented code, HTML comments,
 * the raw-text blocks `<script>`/`<pre>`/`<style>`/`<textarea>`, processing instructions,
 * declarations, CDATA, and any other HTML block until the blank line that ends it — and errs
 * toward hiding a line it cannot classify. A record nobody can see is not a record.
 */
export declare function topLevelMarkdownLines(markdown: string): Array<string | undefined>;

/**
 * Reads the single SDK publication record out of `docs/status.md`.
 *
 * Throws `SdkPublicationStatusError` unless the document holds exactly one publication table with
 * exactly one record, whose package spec equals `${packageName}@${version}` and whose state is one
 * of the two allowed words. It reports what the document claims; it does not consult the registry.
 */
export declare function readSdkPublicationStatus(
  markdown: string,
  expected: { packageName: string; version: string },
): { packageSpec: string; state: SdkPublicationState };
