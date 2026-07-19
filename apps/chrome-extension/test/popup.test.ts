// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ScanResponse } from "../src/messages.js";

/**
 * Popup least-privilege injection (P10-T5). Opening the toolbar popup grants temporary activeTab
 * access; clicking Scan must (1) use that grant to inject content.js into the active tab via
 * chrome.scripting.executeScript and (2) only then message it. These tests assert that order and
 * that an injection failure (chrome://, Web Store, …) surfaces a friendly message instead of
 * throwing.
 */

const TAB_ID = 42;
const EMPTY_REPORT: ScanResponse = {
  ok: true,
  report: {
    kind: "single",
    schemaVersion: "0.1",
    toolVersion: "9.9.9",
    generatedAt: "",
    input: { runtime: "dom" },
    summary: { total: 0, bySeverity: { info: 0, low: 0, medium: 0, high: 0 } },
    findings: [],
  },
};

let executeScript: ReturnType<typeof vi.fn>;
let sendMessage: ReturnType<typeof vi.fn>;

function setPopupDom(): void {
  document.body.innerHTML = `
    <p id="disclaimer"></p>
    <button id="scan" type="button">Scan this page</button>
    <p id="status"></p>
    <div id="results"></div>`;
}

beforeEach(() => {
  setPopupDom();
  executeScript = vi.fn().mockResolvedValue([]);
  sendMessage = vi.fn().mockResolvedValue(EMPTY_REPORT);
  (globalThis as unknown as { chrome: unknown }).chrome = {
    tabs: {
      query: vi.fn().mockResolvedValue([{ id: TAB_ID, active: true }]),
      sendMessage,
    },
    scripting: { executeScript },
  };
  vi.resetModules();
});

afterEach(() => {
  (globalThis as unknown as { chrome?: unknown }).chrome = undefined;
});

async function clickScanAndSettle(): Promise<void> {
  await import("../src/popup.js");
  document.getElementById("scan")?.dispatchEvent(new Event("click"));
  // scan() is async (executeScript → sendMessage → render); let the microtask chain drain.
  await new Promise((r) => setTimeout(r, 0));
}

describe("popup Scan button (programmatic injection)", () => {
  it("injects content.js into the active tab, THEN messages it", async () => {
    await clickScanAndSettle();

    expect(executeScript).toHaveBeenCalledWith({
      target: { tabId: TAB_ID },
      files: ["content.js"],
    });
    expect(sendMessage).toHaveBeenCalledWith(TAB_ID, { type: "FAIRUX_SCAN" });
    // Injection must precede messaging: an un-injected tab has no listener to answer. Both mocks are
    // asserted called above, so their first invocation order is defined.
    const injectOrder = executeScript.mock.invocationCallOrder[0] as number;
    const messageOrder = sendMessage.mock.invocationCallOrder[0] as number;
    expect(injectOrder).toBeLessThan(messageOrder);
  });

  it("does not message the tab when injection fails (chrome://, Web Store, …)", async () => {
    executeScript.mockRejectedValue(new Error("Cannot access contents of the page"));
    await clickScanAndSettle();

    expect(sendMessage).not.toHaveBeenCalled();
    expect(document.getElementById("status")?.textContent).toContain("Can't scan this page");
  });
});
