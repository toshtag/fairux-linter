// @vitest-environment happy-dom
import { type FairUxReport, SHADOW_LOCATOR_SEPARATOR } from "@fairux/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionMessage, HighlightResponse, ScanResponse } from "../src/messages.js";

type Listener = (
  msg: ExtensionMessage,
  sender: unknown,
  sendResponse: (r: ScanResponse | HighlightResponse) => void,
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
      response = r as ScanResponse;
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

  /**
   * `document.querySelector` cannot cross a shadow boundary, and the DOM adapter walks into open
   * shadow roots — so a finding in one had a locator that resolved against the light DOM and
   * outlined whatever sat at those `:nth-child` indexes. Being wrong looked exactly like being
   * right. A locator crossing a boundary is a sequence now, resolved one root at a time.
   */
  describe("a locator that crosses a shadow boundary", () => {
    const highlight = (value: string): boolean | undefined => {
      let answered: HighlightResponse | undefined;
      listener?.({ type: "FAIRUX_HIGHLIGHT", locator: { type: "css", value } }, {}, (r) => {
        answered = r as HighlightResponse;
      });
      return answered?.highlighted;
    };

    it("outlines the element inside an open shadow root", async () => {
      document.documentElement.innerHTML = "<body></body>";
      const host = document.createElement("my-banner");
      document.body.append(host);
      const root = host.attachShadow({ mode: "open" });
      root.innerHTML = "<button>Accept</button>";
      await import("../src/content.js");

      expect(highlight(`my-banner${SHADOW_LOCATOR_SEPARATOR}button:nth-child(1)`)).toBe(true);
      expect((root.querySelector("button") as HTMLElement).style.outline).toContain("3px");
    });

    it("outlines nothing when the root is closed, and says the highlight did not happen", async () => {
      document.documentElement.innerHTML = "<body></body>";
      const host = document.createElement("my-secret");
      document.body.append(host);
      host.attachShadow({ mode: "closed" }).innerHTML = "<button>Hidden</button>";
      await import("../src/content.js");

      expect(highlight(`my-secret${SHADOW_LOCATOR_SEPARATOR}button:nth-child(1)`)).toBe(false);
      // Not the host, which is not the finding, and not anything else.
      expect((host as HTMLElement).style.outline).toBe("");
    });

    it("does not fall back to the document when a hop cannot be taken", async () => {
      // The defect, exactly: a second segment resolved against the document matches this button.
      document.documentElement.innerHTML = "<body><div><button>Wrong one</button></div></body>";
      const host = document.createElement("my-banner");
      document.body.append(host);
      await import("../src/content.js");

      expect(highlight(`my-banner${SHADOW_LOCATOR_SEPARATOR}div:nth-child(1)`)).toBe(false);
      const wrong = document.querySelector("div") as HTMLElement;
      expect(wrong.style.outline).toBe("");
    });

    it("reports an unresolvable and an invalid locator without throwing", async () => {
      document.documentElement.innerHTML = "<body><p>nothing to point at</p></body>";
      await import("../src/content.js");

      expect(highlight("#gone")).toBe(false);
      expect(highlight("::::not a selector")).toBe(false);
    });

    it("answers a locator kind this runtime cannot produce", async () => {
      document.documentElement.innerHTML = "<body></body>";
      await import("../src/content.js");
      let answered: HighlightResponse | undefined;
      listener?.(
        { type: "FAIRUX_HIGHLIGHT", locator: { type: "figma", nodeId: "1:2" } },
        {},
        (r) => {
          answered = r as HighlightResponse;
        },
      );
      expect(answered?.highlighted).toBe(false);
    });
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
