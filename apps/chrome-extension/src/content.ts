import type { ExtensionMessage, ScanResponse } from "./messages.js";
import { scanCurrentDocument } from "./scan-page.js";

const EXTENSION_VERSION = "0.1.0";
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

chrome.runtime.onMessage.addListener(
  (message: ExtensionMessage, _sender, sendResponse: (r: ScanResponse) => void) => {
    if (message.type === "FAIRUX_SCAN") {
      try {
        sendResponse({ ok: true, report: scanCurrentDocument(document, EXTENSION_VERSION) });
      } catch (error) {
        sendResponse({ ok: false, error: (error as Error).message });
      }
      return; // synchronous response
    }
    if (message.type === "FAIRUX_HIGHLIGHT" && message.locator.type === "css") {
      highlight(message.locator.value);
    }
  },
);
