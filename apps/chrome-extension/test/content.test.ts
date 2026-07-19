// @vitest-environment happy-dom
import type { FairUxReport } from "@fairux/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionMessage, ScanResponse } from "../src/messages.js";

type Listener = (
  msg: ExtensionMessage,
  sender: unknown,
  sendResponse: (r: ScanResponse) => void,
) => void;

let listener: Listener | undefined;

beforeEach(() => {
  listener = undefined;
  // Minimal chrome stub: capture the registered onMessage listener so we can invoke it, and provide
  // getManifest so content.ts can single-source its version from the manifest (P10-T3).
  (globalThis as unknown as { chrome: unknown }).chrome = {
    runtime: {
      getManifest: () => ({ version: "9.9.9" }),
      onMessage: {
        addListener: (fn: Listener) => {
          listener = fn;
        },
      },
    },
  };
  // content.ts is injected programmatically and guards listener registration with a per-document
  // window flag (P10-T5). resetModules() clears the module cache but NOT window state, so clear the
  // flag too — otherwise a re-import behaves like a re-injection into the same document and skips
  // registration, leaving `listener` undefined.
  (window as Window & { __fairuxContentInjected?: boolean }).__fairuxContentInjected = undefined;
  vi.resetModules();
});

afterEach(() => {
  (globalThis as unknown as { chrome?: unknown }).chrome = undefined;
});

describe("content script message handling", () => {
  it("responds to FAIRUX_SCAN with a report for the current document", async () => {
    document.documentElement.innerHTML = `<body><h1>Cookie consent</h1>
      <label><input type="checkbox" checked> Email me marketing offers</label></body>`;
    await import("../src/content.js");
    expect(listener).toBeDefined();

    let response: ScanResponse | undefined;
    listener?.({ type: "FAIRUX_SCAN" }, {}, (r) => {
      response = r;
    });

    expect(response?.ok).toBe(true);
    const report = (response as { ok: true; report: FairUxReport }).report;
    expect(report.input.runtime).toBe("dom");
    // toolVersion comes from chrome.runtime.getManifest().version (the stub above), not a hardcoded
    // constant — proving the single-source path from manifest → report (P10-T3).
    expect(report.toolVersion).toBe("9.9.9");
    expect(report.findings.map((f) => f.ruleId)).toContain("consent/checked-checkbox");
  });

  it("highlights the located element on FAIRUX_HIGHLIGHT (outline applied)", async () => {
    document.documentElement.innerHTML = `<body><button id="cta">Buy now</button></body>`;
    await import("../src/content.js");

    listener?.({ type: "FAIRUX_HIGHLIGHT", locator: { type: "css", value: "#cta" } }, {}, () => {});

    const cta = document.getElementById("cta") as HTMLElement;
    expect(cta.style.outline).toContain("3px");
  });

  it("re-injection into the same document registers the listener only once (idempotent)", async () => {
    // Programmatic injection re-runs the whole file on each Scan click. Count addListener calls and
    // prove the window-flag guard registers exactly one listener across repeated injections, so a
    // second Scan won't get a duplicate (double) response. (P10-T5)
    let addCount = 0;
    (globalThis as unknown as { chrome: unknown }).chrome = {
      runtime: {
        getManifest: () => ({ version: "9.9.9" }),
        onMessage: { addListener: () => addCount++ },
      },
    };
    await import("../src/content.js"); // first injection
    vi.resetModules(); // module cache cleared, but window flag persists (same document)
    await import("../src/content.js"); // second injection into the SAME document
    expect(addCount).toBe(1);
  });
});
