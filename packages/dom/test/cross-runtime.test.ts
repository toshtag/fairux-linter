// @vitest-environment happy-dom
import { scan } from "@fairux/core";
import { parseHtml } from "@fairux/html";
import { allRules, dictionary } from "@fairux/rules";
import { describe, expect, it } from "vitest";
import { parseDocument } from "../src/index.js";

/**
 * The whole point of the DOM adapter (ADR P3-T1): the EXISTING rules run on a live DOM with
 * zero changes, and findings line up with their static-HTML twins — same ruleIds and, where
 * the markup is identical, the SAME fingerprints (so CI baselines transfer between runtimes).
 */

const ruleIds = (findings: { ruleId: string }[]) => findings.map((f) => f.ruleId).sort();

function scanDom(html: string) {
  document.documentElement.innerHTML = html;
  return scan(parseDocument(document), allRules, { dictionary });
}

function scanStatic(html: string) {
  return scan(parseHtml(`<!doctype html><html>${html}</html>`), allRules, { dictionary });
}

describe("existing rules run on the DOM adapter unchanged", () => {
  it("flags a pre-checked marketing box on a consent page (DOM runtime)", () => {
    const report = scanDom(
      `<body><h1>Cookie consent</h1>
        <label><input type="checkbox" checked> Email me marketing offers</label></body>`,
    );
    expect(ruleIds(report.findings)).toContain("consent/checked-checkbox");
  });

  it("flags an accept-only consent banner + scarcity on a JA checkout (DOM runtime)", () => {
    const report = scanDom(
      `<body lang="ja"><h1>購入手続き</h1>
        <p>クッキーを使用します。</p>
        <button>同意する</button>
        <p>残りわずか、お早めに！</p></body>`,
    );
    const ids = ruleIds(report.findings);
    expect(ids).toContain("consent/missing-reject-option");
    expect(ids).toContain("scarcity/scarcity-phrase");
  });

  it("produces the same ruleIds as the static-HTML adapter for identical markup", () => {
    const body = `<body><h1>Pricing</h1><section><a href="/sub">Subscribe</a><p>$9/month</p></section></body>`;
    expect(ruleIds(scanDom(body).findings)).toEqual(ruleIds(scanStatic(body).findings));
  });

  it("produces fingerprints that transfer between runtimes (id-anchored finding)", () => {
    // An element with a stable id → identical locator across runtimes → identical fingerprint.
    const body = `<body><h1>Cookie consent</h1>
      <label for="mk">Email me marketing offers</label>
      <input id="mk" type="checkbox" checked></body>`;

    const domFinding = scanDom(body).findings.find((f) => f.ruleId === "consent/checked-checkbox");
    const staticFinding = scanStatic(body).findings.find(
      (f) => f.ruleId === "consent/checked-checkbox",
    );

    expect(domFinding).toBeDefined();
    expect(staticFinding).toBeDefined();
    expect(domFinding?.fingerprint).toBe(staticFinding?.fingerprint);
  });
});
