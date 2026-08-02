// @vitest-environment happy-dom
import { scan } from "@fairux/core";
import { parseHtml } from "@fairux/html";
import { allRules, dictionary } from "@fairux/rules";
import { describe, expect, it } from "vitest";
import { readCorpusPages } from "../scripts/corpus-source.mjs";
import { parseDocument } from "../src/index.js";

const pages = readCorpusPages();

/** Findings per rule. Not fingerprints: those carry locators, which the two parsers derive differently. */
function countsByRule(findings: readonly { ruleId: string }[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const finding of findings) out[finding.ruleId] = (out[finding.ruleId] ?? 0) + 1;
  return out;
}

/** The markup inside `<html>`, which is what a live document's `documentElement` holds. */
function innerHtmlOf(source: string): string {
  const opened = source.search(/<html[^>]*>/i);
  const closed = source.search(/<\/html\s*>/i);
  if (opened === -1 || closed === -1) return source;
  return source.slice(source.indexOf(">", opened) + 1, closed);
}

/**
 * Every corpus page, through both adapters, compared.
 *
 * The DOM adapter exists so the same rules run in a browser extension. Its existing tests use three
 * hand-written snippets, which proves the adapter works and not that it agrees — a divergence would
 * surface as the CLI and the extension reporting different things about the same page, and nothing
 * was checking for that across the pages the project actually has.
 *
 * One test per page rather than one loop, so a failure names the page instead of the sweep.
 */
describe("every corpus page, through both adapters", () => {
  it("has pages to compare, so a passing sweep is not an empty one", () => {
    expect(pages.length).toBeGreaterThan(40);
  });

  for (const page of pages) {
    it(`agrees on ${page.id}`, () => {
      const source = page.source;
      const inner = innerHtmlOf(source);
      expect(inner.length, `${page.id}: nothing extracted`).toBeGreaterThan(0);

      const staticReport = scan(parseHtml(source, { file: page.id }), allRules, { dictionary });
      document.documentElement.innerHTML = inner;
      const domReport = scan(parseDocument(document), allRules, { dictionary });

      expect(countsByRule(domReport.findings)).toEqual(countsByRule(staticReport.findings));
    });
  }
});
