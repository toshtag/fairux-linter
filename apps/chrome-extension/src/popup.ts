import type { Finding, Severity } from "@fairux/core";
import type { ExtensionMessage, HighlightResponse, ScanResponse } from "./messages.js";

const SEVERITY_ORDER: Severity[] = ["high", "medium", "low", "info"];
/** What a severity is called in a heading a screen reader announces. */
const SEVERITY_HEADING: Readonly<Record<Severity, string>> = Object.freeze({
  high: "High severity",
  medium: "Medium severity",
  low: "Low severity",
  info: "Informational",
});
const DISCLAIMER =
  "FairUX does not provide legal judgments. Findings are UX risk signals for review.";

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> = {},
  children: (Node | string)[] = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  Object.assign(node, props);
  for (const child of children) node.append(child);
  return node;
}

async function activeTabId(): Promise<number | undefined> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab?.id;
}

function send<T = void>(tabId: number, message: ExtensionMessage): Promise<T> {
  return chrome.tabs.sendMessage(tabId, message) as Promise<T>;
}

/**
 * Say something, once, where assistive technology will hear it.
 *
 * `#status` is a live region, so replacing its text announces it without moving focus. Everything
 * that used to be silent — a highlight that resolved nothing, a scan that finished — arrives here.
 */
function announce(text: string): void {
  const status = document.getElementById("status");
  if (status) status.textContent = text;
}

/**
 * One finding.
 *
 * The row used to be a `<li>` with a click listener, which is a control only a mouse can reach: no
 * tab stop, no Enter or Space, no focus ring, and nothing announcing it as operable. A finding that
 * can be highlighted is now a real `<button>`, which is where all of that comes from rather than
 * being reimplemented with `tabindex` and key handlers. A finding with no locator is not a control
 * at all and stays plain text, because a button that does nothing is worse than no button.
 *
 * `<button>` takes phrasing content, so the lines inside it are `<span>`s made block-level by the
 * stylesheet — a `<div>` in there is invalid and browsers recover from it differently.
 */
function renderFinding(tabId: number, finding: Finding): HTMLElement {
  const locator = finding.evidence[0]?.locator;
  const lines = (tag: "span" | "div") => [
    el(tag, { className: "finding-head" }, [
      el("span", { className: "badge", textContent: finding.severity }),
      el("span", { className: "title", textContent: finding.title }),
    ]),
    el(tag, { className: "desc", textContent: finding.description }),
    el(tag, { className: "rec", textContent: `→ ${finding.recommendation}` }),
  ];

  if (!locator) {
    return el("li", { className: `finding sev-${finding.severity}` }, lines("div"));
  }

  const button = el(
    "button",
    {
      type: "button",
      className: "finding-activate",
      // Says what activating it does. The visible text is the finding, not the action.
      title: "Highlight this on the page",
    },
    lines("span"),
  );
  button.addEventListener("click", () => {
    void send<HighlightResponse>(tabId, { type: "FAIRUX_HIGHLIGHT", locator })
      .then((response) => {
        announce(
          response?.highlighted
            ? `Highlighted: ${finding.title}`
            : `Could not highlight ${finding.title} — the element is not reachable on this page.`,
        );
      })
      .catch(() => {
        // The tab may have navigated since the scan, removing the injected content script.
        announce("Could not highlight — the page has changed since the scan. Scan again.");
      });
  });
  return el("li", { className: `finding sev-${finding.severity}` }, [button]);
}

function render(report: ScanResponse, tabId: number): void {
  const out = document.getElementById("results");
  if (!out) return;
  out.replaceChildren();

  if (!report.ok) {
    out.append(el("p", { className: "error", textContent: `Scan failed: ${report.error}` }));
    announce(`Scan failed: ${report.error}`);
    return;
  }
  const { summary, findings } = report.report;
  const summaryText = `${summary.total} finding(s) — high ${summary.bySeverity.high}, medium ${summary.bySeverity.medium}, low ${summary.bySeverity.low}, info ${summary.bySeverity.info}`;
  out.append(el("p", { className: "summary", textContent: summaryText }));
  if (findings.length === 0) {
    out.append(el("p", { textContent: "No findings on this page." }));
    // Not a statement that the page is fair or compliant, and the disclaimer above says so.
    announce("Scan complete. No findings on this page.");
    return;
  }
  for (const severity of SEVERITY_ORDER) {
    const group = findings.filter((f) => f.severity === severity);
    if (group.length === 0) continue;
    // A section per severity with its own heading, so the list can be reached by heading and its
    // items are announced as "N items" rather than as one run of text.
    const heading = el("h2", {
      className: "group-heading",
      id: `group-${severity}`,
      textContent: `${SEVERITY_HEADING[severity]} (${group.length})`,
    });
    const list = el(
      "ul",
      { className: "findings" },
      group.map((f) => renderFinding(tabId, f)),
    );
    list.setAttribute("aria-labelledby", heading.id);
    out.append(el("section", { className: "group" }, [heading, list]));
  }
  announce(`Scan complete. ${summaryText}`);
}

async function scan(): Promise<void> {
  const tabId = await activeTabId();
  if (tabId === undefined) {
    announce("No active tab.");
    return;
  }
  announce("Scanning…");
  try {
    // Opening this popup through the toolbar action grants temporary activeTab access to this tab.
    // Scan uses that existing grant to inject content.js only after the user explicitly requests it.
    // content.js is idempotent, so a repeat Scan won't double-register its message listener.
    await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
    const response = await send<ScanResponse>(tabId, { type: "FAIRUX_SCAN" });
    // `render` announces the outcome, so the region is never left saying "Scanning…".
    render(response, tabId);
  } catch {
    // executeScript throws on pages we're not allowed to inject into (chrome://, the Web Store,
    // the New Tab page, PDFs, …) — there's no activeTab grant for those.
    announce("Can't scan this page. Open a normal website tab and try again.");
  }
}

document.getElementById("scan")?.addEventListener("click", () => void scan());
const disclaimerEl = document.getElementById("disclaimer");
if (disclaimerEl) disclaimerEl.textContent = DISCLAIMER;
