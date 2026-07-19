import { readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Window } from "happy-dom";
import { describe, expect, it } from "vitest";
import { createDomScanner } from "../src/dom.js";
import { scanHtml } from "../src/html.js";
import type { PageContextSignal, RulePack } from "../src/index.js";
import {
  composeRulePacks,
  fairuxBuiltinRulePack,
  RulePackError,
  ScannerPolicyError,
} from "../src/index.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const fixtureRoot = join(repoRoot, "tests", "fixtures", "sdk-custom-rule-pack");

interface ValidFixtureModule {
  readonly rulePack: RulePack;
  readonly scanHtmlInput?: string;
  readonly pageContexts?: readonly PageContextSignal[];
  readonly expectedRuleIds?: readonly string[];
  readonly expectedCategoryIds?: readonly string[];
  readonly expectedPageContextIds?: readonly string[];
}

interface InvalidFixtureModule {
  readonly invalidRulePack: RulePack;
  readonly invalidExpectation?: "compose" | "scan";
  readonly scanHtmlInput?: string;
  readonly expectedError: {
    readonly messagePattern: string;
  };
}

function fixtureFiles(kind: "valid" | "invalid"): string[] {
  return readdirSync(join(fixtureRoot, kind))
    .filter((file) => file.endsWith(".mjs"))
    .sort();
}

async function importFixture<T>(kind: "valid" | "invalid", file: string): Promise<T> {
  return import(pathToFileURL(join(fixtureRoot, kind, file)).href) as Promise<T>;
}

describe("RulePack authoring fixtures", () => {
  for (const file of fixtureFiles("valid")) {
    it(`accepts valid authoring fixture ${file}`, async () => {
      const fixture = await importFixture<ValidFixtureModule>("valid", file);
      const composed = composeRulePacks([fairuxBuiltinRulePack, fixture.rulePack], {
        includeExperimental: true,
      });

      expect(composed.rulePacks.map((pack) => pack.id)).toContain(fixture.rulePack.meta.id);
      for (const categoryId of fixture.expectedCategoryIds ?? []) {
        expect(composed.taxonomy.categories.map((category) => category.id)).toContain(categoryId);
      }
      for (const contextId of fixture.expectedPageContextIds ?? []) {
        expect(composed.taxonomy.pageContexts.map((context) => context.id)).toContain(contextId);
      }

      const html = fixture.scanHtmlInput ?? "<main><button>Buy now</button></main>";
      const htmlReport = scanHtml(html, {
        includeExperimental: true,
        rulePacks: [fairuxBuiltinRulePack, fixture.rulePack],
        pageContexts: fixture.pageContexts,
        now: () => new Date("2026-01-01T00:00:00Z"),
      });
      for (const ruleId of fixture.expectedRuleIds ?? []) {
        expect(htmlReport.findings.map((finding) => finding.ruleId)).toContain(ruleId);
      }

      const window = new Window();
      window.document.body.innerHTML = html;
      const domReport = createDomScanner({
        includeExperimental: true,
        rulePacks: [fairuxBuiltinRulePack, fixture.rulePack],
        now: () => new Date("2026-01-01T00:00:00Z"),
      }).scan(window.document as unknown as Document, { pageContexts: fixture.pageContexts });
      for (const ruleId of fixture.expectedRuleIds ?? []) {
        expect(domReport.findings.map((finding) => finding.ruleId)).toContain(ruleId);
      }
    });
  }

  for (const file of fixtureFiles("invalid")) {
    it(`rejects invalid authoring fixture ${file}`, async () => {
      const fixture = await importFixture<InvalidFixtureModule>("invalid", file);
      const expectation = fixture.invalidExpectation ?? "compose";
      const action =
        expectation === "scan"
          ? () =>
              scanHtml(fixture.scanHtmlInput ?? "<main><button>Buy now</button></main>", {
                rulePacks: [fixture.invalidRulePack],
                now: () => new Date("2026-01-01T00:00:00Z"),
              })
          : () => composeRulePacks([fixture.invalidRulePack], { includeExperimental: true });

      expect(action).toThrow(RulePackError);
      expect(action).toThrow(fixture.expectedError.messagePattern);
    });
  }

  it("rejects undeclared caller-supplied page contexts at scan time", async () => {
    const fixture = await importFixture<ValidFixtureModule>("valid", "page-context-pack.mjs");
    const scanner = createDomScanner({
      rulePacks: [fixture.rulePack],
      now: () => new Date("2026-01-01T00:00:00Z"),
    });
    const window = new Window();
    window.document.body.innerHTML = fixture.scanHtmlInput ?? "<main><input></main>";

    expect(() =>
      scanner.scan(window.document as unknown as Document, {
        pageContexts: [{ context: "purchase-guard/undeclared-form", confidence: "high" }],
      }),
    ).toThrow(ScannerPolicyError);
  });
});
