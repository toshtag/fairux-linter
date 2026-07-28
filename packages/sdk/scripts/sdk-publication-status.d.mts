export declare const SDK_PUBLICATION_HEADING: "### SDK publication state";
export declare const SDK_PUBLICATION_HEADER_ROW: readonly string[];
export declare const SDK_PUBLICATION_STATES: readonly ["published", "unpublished"];

export type SdkPublicationState = (typeof SDK_PUBLICATION_STATES)[number];

export declare class SdkPublicationStatusError extends Error {
  readonly name: "SdkPublicationStatusError";
}

/**
 * The lines a reader would see: fenced blocks and HTML comments become `undefined`, including
 * everything after one that is never closed. A record nobody can see is not a record.
 */
export declare function visibleMarkdownLines(markdown: string): Array<string | undefined>;

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
