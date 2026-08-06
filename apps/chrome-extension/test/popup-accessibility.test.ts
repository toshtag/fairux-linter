// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Finding } from "@fairux/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionMessage, HighlightResponse, ScanResponse } from "../src/messages.js";

/**
 * What the popup renders, judged the way it judges a page.
 *
 * A finding row was a `<li>` with a click listener: reachable by mouse and by nothing else. No tab
 * stop, no Enter or Space, no focus ring, and nothing telling assistive technology it was operable.
 * The severity groups were bare `<ul>`s with no heading, and the one status line was an ordinary
 * paragraph — so a scan finishing, a scan failing, and a highlight that found nothing were all
 * silent.
 *
 * This file is the rendered contract. It does not check colours or spacing; it checks that every
 * control is a control, that the structure has names, and that outcomes are announced.
 */

const here = dirname(fileURLToPath(import.meta.url));
const TAB_ID = 42;

const finding = (over: Partial<Finding> = {}): Finding =>
  ({
    id: "F-1",
    ruleId: "consent/checked-checkbox",
    title: "Pre-checked consent",
    description: "A consent checkbox is checked by default.",
    recommendation: "Leave consent controls unchecked.",
    severity: "high",
    confidence: "high",
    category: "consent",
    evidence: [{ locator: { type: "css", value: "#c" }, snippet: "<input checked>" }],
    ...over,
  }) as unknown as Finding;

const reportWith = (findings: Finding[]): ScanResponse => ({
  ok: true,
  report: {
    kind: "single",
    schemaVersion: "0.1",
    toolVersion: "9.9.9",
    generatedAt: "",
    input: { runtime: "dom" },
    summary: {
      total: findings.length,
      bySeverity: {
        info: findings.filter((f) => f.severity === "info").length,
        low: findings.filter((f) => f.severity === "low").length,
        medium: findings.filter((f) => f.severity === "medium").length,
        high: findings.filter((f) => f.severity === "high").length,
      },
    },
    findings,
  },
});

let sendMessage: ReturnType<typeof vi.fn>;

beforeEach(() => {
  document.body.innerHTML = `
    <p id="disclaimer"></p>
    <button id="scan" type="button">Scan this page</button>
    <p id="status" role="status" aria-live="polite"></p>
    <div id="results"></div>`;
  sendMessage = vi.fn().mockResolvedValue(reportWith([finding()]));
  (globalThis as unknown as { chrome: unknown }).chrome = {
    tabs: {
      query: vi.fn().mockResolvedValue([{ id: TAB_ID, active: true }]),
      sendMessage,
    },
    scripting: { executeScript: vi.fn().mockResolvedValue([]) },
  };
  vi.resetModules();
});

afterEach(() => {
  (globalThis as unknown as { chrome?: unknown }).chrome = undefined;
});

async function scanAndSettle(): Promise<void> {
  await import("../src/popup.js");
  document.getElementById("scan")?.dispatchEvent(new Event("click"));
  await new Promise((r) => setTimeout(r, 0));
}

const status = () => document.getElementById("status")?.textContent ?? "";

describe("the popup markup it ships", () => {
  it("declares the status paragraph as a live region", () => {
    // The announcements below are only announcements because of these two attributes, and they live
    // in a file no test would otherwise open.
    const html = readFileSync(resolve(here, "../static/popup.html"), "utf8");
    expect(html).toContain('id="status" role="status" aria-live="polite"');
  });

  it("never suppresses the focus outline, and defines a visible one", () => {
    const html = readFileSync(resolve(here, "../static/popup.html"), "utf8");
    expect(html).not.toMatch(/outline:\s*(none|0)/);
    expect(html).toContain(":focus-visible");
  });
});

describe("a finding row is a real control", () => {
  it("renders a locatable finding as a button, not a clickable list item", async () => {
    await scanAndSettle();
    const button = document.querySelector("li.finding button");
    expect(button).not.toBeNull();
    expect((button as HTMLButtonElement).type).toBe("button");
    // A button is a tab stop and is announced as operable because it is a button — not because of a
    // `tabindex` and a keydown handler bolted onto something that is not one.
    expect(document.querySelector("li.finding[tabindex]")).toBeNull();
  });

  it("activates on Enter and Space, because it is a button", async () => {
    await scanAndSettle();
    const button = document.querySelector("li.finding button") as HTMLButtonElement;
    sendMessage.mockResolvedValue({ highlighted: true } satisfies HighlightResponse);

    // happy-dom, like a browser, fires `click` for Enter and Space on a button. Asserting the
    // element is a button and that a click reaches the handler is the same claim, checked where the
    // browser makes it rather than where a key handler would have to reimplement it.
    button.click();
    await new Promise((r) => setTimeout(r, 0));

    const highlight = sendMessage.mock.calls.find(
      (call) => (call[1] as ExtensionMessage).type === "FAIRUX_HIGHLIGHT",
    );
    expect(highlight).toBeDefined();
    expect(button.matches(":disabled")).toBe(false);
  });

  it("contains only phrasing content, so the button markup is valid", async () => {
    await scanAndSettle();
    const button = document.querySelector("li.finding button") as HTMLElement;
    expect(button.querySelector("div")).toBeNull();
    expect(button.querySelectorAll("span").length).toBeGreaterThan(0);
  });

  it("does not make a finding without a locator look operable", async () => {
    sendMessage.mockResolvedValue(reportWith([finding({ evidence: [] })]));
    await scanAndSettle();
    expect(document.querySelector("li.finding button")).toBeNull();
    expect(document.querySelector("li.finding")).not.toBeNull();
  });
});

describe("the findings have a structure a screen reader can navigate", () => {
  it("groups each severity under its own heading, and names the list after it", async () => {
    sendMessage.mockResolvedValue(
      reportWith([finding(), finding({ id: "F-2", severity: "low", title: "Second" })]),
    );
    await scanAndSettle();

    const headings = [...document.querySelectorAll("h2.group-heading")].map((h) => h.textContent);
    expect(headings).toEqual(["High severity (1)", "Low severity (1)"]);

    for (const list of document.querySelectorAll("ul.findings")) {
      const labelledBy = list.getAttribute("aria-labelledby");
      expect(labelledBy).toBeTruthy();
      expect(document.getElementById(String(labelledBy))).not.toBeNull();
    }
  });
});

describe("outcomes are announced, not just drawn", () => {
  it("says the scan finished, with the counts", async () => {
    await scanAndSettle();
    expect(status()).toContain("Scan complete");
    expect(status()).toContain("1 finding(s)");
  });

  it("says an empty scan finished, without saying the page is fine", async () => {
    sendMessage.mockResolvedValue(reportWith([]));
    await scanAndSettle();
    expect(status()).toContain("No findings on this page");
    expect(status()).not.toMatch(/safe|compliant|fair\b/i);
  });

  it("says when a highlight resolved nothing, instead of appearing to do nothing", async () => {
    await scanAndSettle();
    sendMessage.mockResolvedValue({ highlighted: false } satisfies HighlightResponse);
    (document.querySelector("li.finding button") as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 0));

    expect(status()).toContain("Could not highlight");
  });

  it("says when a highlight worked", async () => {
    await scanAndSettle();
    sendMessage.mockResolvedValue({ highlighted: true } satisfies HighlightResponse);
    (document.querySelector("li.finding button") as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 0));

    expect(status()).toContain("Highlighted");
  });

  it("says when the page has moved on since the scan", async () => {
    await scanAndSettle();
    sendMessage.mockRejectedValue(new Error("Receiving end does not exist"));
    (document.querySelector("li.finding button") as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 0));

    expect(status()).toContain("the page has changed");
  });

  it("says a failed scan failed", async () => {
    sendMessage.mockResolvedValue({ ok: false, error: "input too large" } satisfies ScanResponse);
    await scanAndSettle();
    expect(status()).toContain("Scan failed");
    expect(document.querySelector(".error")?.textContent).toContain("input too large");
  });
});
