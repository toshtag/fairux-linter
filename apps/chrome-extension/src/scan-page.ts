import { createScanner, type FairUxReport } from "@fairux/core";
import { parseDocument } from "@fairux/dom";
import { fairuxBuiltinRulePack } from "@fairux/rules";

/**
 * Scan a live DOM document for FairUX risk signals. This is the whole "engine" of the extension,
 * factored out of the content script so it can be unit-tested under happy-dom without a browser.
 * Everything here is browser-safe (@fairux/core + /dom + /rules); no network, no AI.
 */
export function scanCurrentDocument(doc: Document, toolVersion: string): FairUxReport {
  return createScanner({
    rulePacks: [fairuxBuiltinRulePack],
    toolVersion,
  }).scan(parseDocument(doc, { url: doc.location?.href }));
}
