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
  }).scan(
    parseDocument(doc, {
      url: doc.location?.href,
      // On here, unlike everywhere else. This is the one surface with a rendering engine and a page
      // the user is looking at right now, which is the only place `computed-style` and `viewport`
      // can come from at all. The cost — one layout read per element — is paid once, on demand,
      // for the single page someone asked about, rather than per file in a CI run.
      visualFacts: true,
      // Same reasoning: constraint validation exists only in a live form, and this is the surface
      // that has one.
      formFacts: true,
    }),
  );
}
