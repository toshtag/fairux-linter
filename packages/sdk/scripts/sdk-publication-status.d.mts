export declare const SDK_PUBLICATION_HEADING: "### SDK publication state";
export declare const SDK_PUBLICATION_HEADER_ROW: readonly string[];
export declare const SDK_PUBLICATION_STATES: readonly ["published", "unpublished"];

export type SdkPublicationState = (typeof SDK_PUBLICATION_STATES)[number];

export declare class SdkPublicationStatusError extends Error {
  readonly name: "SdkPublicationStatusError";
}

/**
 * Source lines outside the opaque block contexts this scanner recognises, with every other position
 * replaced by `undefined`.
 *
 * Skipped: fenced code, indented code, HTML comments, the raw-text blocks
 * `<script>`/`<pre>`/`<style>`/`<textarea>`, processing instructions, declarations, CDATA, and any
 * other HTML block until the blank line that ends it. Within those enumerated contexts an unclosed
 * block keeps every later line skipped; syntax outside them is not interpreted as part of this
 * contract. Not a Markdown renderer, an HTML parser, or a visibility check; a returned line is not
 * thereby proven to be anything in particular, and list nesting is not analysed. The canonical
 * publication heading and table are constrained separately, by requiring column zero.
 */
export declare function nonOpaqueMarkdownLines(markdown: string): Array<string | undefined>;

/**
 * Reads the single SDK publication record out of `docs/status.md`.
 *
 * Throws `SdkPublicationStatusError` unless the document holds exactly one publication table with
 * exactly one record, whose package spec equals `${packageName}@${version}` and whose state is one
 * of the two allowed words. The heading and every table row must start at column zero — narrower
 * than Markdown, so a list-nested or otherwise indented record cannot satisfy the contract. It
 * reports what the document claims; it does not consult the registry.
 */
export declare function readSdkPublicationStatus(
  markdown: string,
  expected: { packageName: string; version: string },
): { packageSpec: string; state: SdkPublicationState };
