import type { ExtensionMessage, ScanResponse } from "./messages.js";
import { scanCurrentDocument } from "./scan-page.js";

// Single source of truth for the extension version: the manifest. `chrome.runtime.getManifest()`
// returns the parsed manifest.json at runtime, so report.toolVersion can never drift from the
// version Chrome shows — the same single-source fix applied to the CLI (P10-T3). The extension is
// versioned independently of the CLI (see README): manifest version is its canonical version.
const EXTENSION_VERSION = chrome.runtime.getManifest().version;
const HIGHLIGHT_MS = 2000;

/** Scroll to and briefly outline the element a CSS-located finding points at. */
function highlight(selector: string): void {
  let el: Element | null = null;
  try {
    el = document.querySelector(selector);
  } catch {
    // An unusual generated selector may not be valid querySelector input; fail quietly.
    el = null;
  }
  if (!(el instanceof HTMLElement)) return;
  el.scrollIntoView({ behavior: "smooth", block: "center" });
  const previousOutline = el.style.outline;
  el.style.outline = "3px solid #d6336c";
  window.setTimeout(() => {
    el.style.outline = previousOutline;
  }, HIGHLIGHT_MS);
}

// This script is injected programmatically (chrome.scripting.executeScript) on each Scan click,
// not statically. Re-injecting re-runs the whole file, so guard the listener registration with a
// window flag — otherwise a second Scan would register a duplicate onMessage listener and respond
// twice. The flag is per-document, so a fresh page load (which clears it) re-registers correctly.
const INJECTED_FLAG = "__fairuxContentInjected";
const w = window as Window & { [INJECTED_FLAG]?: boolean };
if (!w[INJECTED_FLAG]) {
  chrome.runtime.onMessage.addListener(
    (message: ExtensionMessage, _sender, sendResponse: (r: ScanResponse) => void) => {
      if (message.type === "FAIRUX_SCAN") {
        try {
          sendResponse({ ok: true, report: scanCurrentDocument(document, EXTENSION_VERSION) });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          sendResponse({ ok: false, error: message });
        }
        return; // synchronous response
      }
      if (message.type === "FAIRUX_HIGHLIGHT" && message.locator.type === "css") {
        highlight(message.locator.value);
      }
    },
  );
  // Set the guard only after registration succeeds, so a failed registration can be retried.
  w[INJECTED_FLAG] = true;
}
