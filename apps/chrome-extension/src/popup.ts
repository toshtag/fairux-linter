import type { Finding, Severity } from "@fairux/core";
import type { ExtensionMessage, ScanResponse } from "./messages.js";

const SEVERITY_ORDER: Severity[] = ["high", "medium", "low", "info"];
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

function renderFinding(tabId: number, finding: Finding): HTMLElement {
  const locator = finding.evidence[0]?.locator;
  const item = el("li", { className: `finding sev-${finding.severity}` }, [
    el("div", { className: "finding-head" }, [
      el("span", { className: "badge", textContent: finding.severity }),
      el("span", { className: "title", textContent: finding.title }),
    ]),
    el("div", { className: "desc", textContent: finding.description }),
    el("div", { className: "rec", textContent: `→ ${finding.recommendation}` }),
  ]);
  if (locator) {
    item.classList.add("clickable");
    item.title = "Click to highlight on the page";
    item.addEventListener("click", () => {
      void send(tabId, { type: "FAIRUX_HIGHLIGHT", locator }).catch(() => {
        // The tab may have navigated since the scan, removing the injected content script.
      });
    });
  }
  return item;
}

function render(report: ScanResponse, tabId: number): void {
  const out = document.getElementById("results");
  if (!out) return;
  out.replaceChildren();

  if (!report.ok) {
    out.append(el("p", { className: "error", textContent: `Scan failed: ${report.error}` }));
    return;
  }
  const { summary, findings } = report.report;
  out.append(
    el("p", {
      className: "summary",
      textContent: `${summary.total} finding(s) — high ${summary.bySeverity.high}, medium ${summary.bySeverity.medium}, low ${summary.bySeverity.low}, info ${summary.bySeverity.info}`,
    }),
  );
  if (findings.length === 0) {
    out.append(el("p", { textContent: "No findings on this page." }));
    return;
  }
  for (const severity of SEVERITY_ORDER) {
    const group = findings.filter((f) => f.severity === severity);
    if (group.length === 0) continue;
    const list = el(
      "ul",
      { className: "findings" },
      group.map((f) => renderFinding(tabId, f)),
    );
    out.append(list);
  }
}

async function scan(): Promise<void> {
  const status = document.getElementById("status");
  const tabId = await activeTabId();
  if (tabId === undefined) {
    if (status) status.textContent = "No active tab.";
    return;
  }
  if (status) status.textContent = "Scanning…";
  try {
    // Opening this popup through the toolbar action grants temporary activeTab access to this tab.
    // Scan uses that existing grant to inject content.js only after the user explicitly requests it.
    // content.js is idempotent, so a repeat Scan won't double-register its message listener.
    await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
    const response = await send<ScanResponse>(tabId, { type: "FAIRUX_SCAN" });
    render(response, tabId);
    if (status) status.textContent = "";
  } catch {
    // executeScript throws on pages we're not allowed to inject into (chrome://, the Web Store,
    // the New Tab page, PDFs, …) — there's no activeTab grant for those.
    if (status) {
      status.textContent = "Can't scan this page. Open a normal website tab and try again.";
    }
  }
}

document.getElementById("scan")?.addEventListener("click", () => void scan());
const disclaimerEl = document.getElementById("disclaimer");
if (disclaimerEl) disclaimerEl.textContent = DISCLAIMER;
