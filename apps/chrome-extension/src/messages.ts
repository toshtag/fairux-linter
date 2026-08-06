import type { FairUxReport, NodeLocator } from "@fairux/core";

/** popup → content: scan the page now. */
export interface ScanRequest {
  type: "FAIRUX_SCAN";
}

/** popup → content: scroll to + outline the element a finding points at. */
export interface HighlightRequest {
  type: "FAIRUX_HIGHLIGHT";
  locator: NodeLocator;
}

export type ExtensionMessage = ScanRequest | HighlightRequest;

/** content → popup: the scan result (or an error message). */
export type ScanResponse = { ok: true; report: FairUxReport } | { ok: false; error: string };

/**
 * content → popup: whether the finding's element was actually found.
 *
 * A highlight that resolved nothing used to be indistinguishable from one that worked: the content
 * script returned nothing either way, and the only feedback was an outline the user might be
 * looking at or might not. A finding inside a closed shadow root, or on a page that has changed
 * since the scan, has no element to outline — and saying so is the difference between "nothing
 * happened" and "this cannot be shown".
 */
export interface HighlightResponse {
  readonly highlighted: boolean;
}
