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
  // Minimal chrome stub: capture the registered onMessage listener so we can invoke it.
  (globalThis as unknown as { chrome: unknown }).chrome = {
    runtime: {
      onMessage: {
        addListener: (fn: Listener) => {
          listener = fn;
        },
      },
    },
  };
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
    expect(report.findings.map((f) => f.ruleId)).toContain("consent/checked-checkbox");
  });

  it("highlights the located element on FAIRUX_HIGHLIGHT (outline applied)", async () => {
    document.documentElement.innerHTML = `<body><button id="cta">Buy now</button></body>`;
    await import("../src/content.js");

    listener?.({ type: "FAIRUX_HIGHLIGHT", locator: { type: "css", value: "#cta" } }, {}, () => {});

    const cta = document.getElementById("cta") as HTMLElement;
    expect(cta.style.outline).toContain("3px");
  });
});
