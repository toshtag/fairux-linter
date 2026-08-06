import { splitCssLocator } from "@fairux/core";
import type { ExtensionMessage, HighlightResponse, ScanResponse } from "./messages.js";
import { scanCurrentDocument } from "./scan-page.js";

// Single source of truth for the extension version: the manifest. `chrome.runtime.getManifest()`
// returns the parsed manifest.json at runtime, so report.toolVersion can never drift from the
// version Chrome shows — the same single-source fix applied to the CLI (P10-T3). The extension is
// versioned independently of the CLI (see README): manifest version is its canonical version.
const EXTENSION_VERSION = chrome.runtime.getManifest().version;
const HIGHLIGHT_MS = 2000;

/**
 * Resolve a `css` locator, hop by hop, through open shadow roots.
 *
 * `document.querySelector` cannot cross a shadow boundary, and the DOM adapter walks into open
 * shadow roots — so a locator for a node inside one is a **sequence**: each segment is resolved
 * against the previous match's `shadowRoot`, starting at the document. See
 * `SHADOW_LOCATOR_SEPARATOR` in `@fairux/core` for why the separator is what it is.
 *
 * Returns `null` for every way this can fail, and never a near miss. A host whose `shadowRoot` is
 * `null` — closed, or detached since the scan — ends the walk rather than highlighting the host,
 * because the host is not the finding. This is the case the flat contract got wrong in the worst
 * possible way: the whole path was resolved against the light DOM, matched whatever sat at those
 * `:nth-child` indexes, and outlined it as if it were the finding.
 */
function resolveLocator(value: string): HTMLElement | null {
  const segments = splitCssLocator(value);
  let scope: Document | ShadowRoot = document;
  let found: Element | null = null;
  for (let index = 0; index < segments.length; index += 1) {
    try {
      found = scope.querySelector(segments[index] as string);
    } catch {
      // An unusual generated selector may not be valid querySelector input; fail quietly.
      return null;
    }
    if (!found) return null;
    if (index === segments.length - 1) break;
    const shadow: ShadowRoot | null | undefined = (
      found as Element & { shadowRoot?: ShadowRoot | null }
    ).shadowRoot;
    // No shadow root to descend into, and segments left to resolve: the finding is somewhere this
    // walk cannot reach. Unresolvable, rather than continuing against the document and matching
    // whatever sits at the next path — which is the wrong element, outlined as if it were right.
    if (!shadow) return null;
    scope = shadow;
  }
  return found instanceof HTMLElement ? found : null;
}

/** Scroll to and briefly outline the element a CSS-located finding points at. */
function highlight(selector: string): boolean {
  const el = resolveLocator(selector);
  if (!el) return false;
  el.scrollIntoView({ behavior: "smooth", block: "center" });
  const previousOutline = el.style.outline;
  el.style.outline = "3px solid #d6336c";
  window.setTimeout(() => {
    el.style.outline = previousOutline;
  }, HIGHLIGHT_MS);
  return true;
}

// This script is injected programmatically (chrome.scripting.executeScript) on each Scan click,
// not statically. Re-injecting re-runs the whole file, so guard the listener registration with a
// window flag — otherwise a second Scan would register a duplicate onMessage listener and respond
// twice. The flag is per-document, so a fresh page load (which clears it) re-registers correctly.
const INJECTED_FLAG = "__fairuxContentInjected";
const w = window as Window & { [INJECTED_FLAG]?: boolean };
if (!w[INJECTED_FLAG]) {
  chrome.runtime.onMessage.addListener(
    (
      message: ExtensionMessage,
      _sender,
      sendResponse: (r: ScanResponse | HighlightResponse) => void,
    ) => {
      if (message.type === "FAIRUX_SCAN") {
        try {
          sendResponse({ ok: true, report: scanCurrentDocument(document, EXTENSION_VERSION) });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          sendResponse({ ok: false, error: message });
        }
        return; // synchronous response
      }
      if (message.type === "FAIRUX_HIGHLIGHT") {
        // Answered either way, including for a locator kind this runtime cannot have: the popup
        // says what happened, and "nothing happened" is not a thing it can say without an answer.
        const highlighted =
          message.locator.type === "css" ? highlight(message.locator.value) : false;
        sendResponse({ highlighted });
      }
    },
  );
  // Set the guard only after registration succeeds, so a failed registration can be retried.
  w[INJECTED_FLAG] = true;
}
