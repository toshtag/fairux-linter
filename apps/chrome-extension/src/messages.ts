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
