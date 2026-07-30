/**
 * The TypeScript half of the v1 registry consumer contract: compiles against the declarations the
 * published SDK ships, for the root, HTML, and DOM entry points, using only types and exports
 * `@fairux/sdk@0.1.0-beta.2` already publishes. Compile-only — never executed. New surface is
 * proven by a future v2 directory, never by editing this one.
 */
import {
  type CapabilityId,
  type ComposedTaxonomy,
  type Finding,
  fairuxBuiltinRulePack,
  type ReadonlyNonEmptyArray,
  type RulePack,
} from "@fairux/sdk";
import { createDomScanner } from "@fairux/sdk/dom";
import { createHtmlScanner, type PageContextInputSignal, scanHtml } from "@fairux/sdk/html";

const configuredPacks: readonly RulePack[] = [fairuxBuiltinRulePack];
const requiredCapabilities: ReadonlyNonEmptyArray<CapabilityId> = ["structure", "text"];
const suppliedPageContexts: readonly PageContextInputSignal[] = [];
const htmlScanner = createHtmlScanner({
  rulePacks: configuredPacks,
  now: () => new Date("2026-01-01T00:00:00Z"),
});
const taxonomy: ComposedTaxonomy = htmlScanner.taxonomy;
const reusableFirst = htmlScanner.scan(
  "<html><body><label><input type='checkbox' checked> Send marketing</label></body></html>",
  { file: "first.html" },
);
const reusableSecond = htmlScanner.scan("<html><body><button>Buy now</button></body></html>", {
  file: "second.html",
});

const report = scanHtml("<html><body><button>Buy now</button></body></html>", {
  rulePacks: configuredPacks,
  pageContexts: suppliedPageContexts,
  now: () => new Date("2026-01-01T00:00:00Z"),
});

const findings: readonly Finding[] = report.findings;
const domScanner = createDomScanner();
const builtinRule = fairuxBuiltinRulePack.rules[0];

if (!builtinRule) {
  throw new Error("Expected the built-in rule pack to include at least one rule.");
}

// @ts-expect-error public built-in rule metadata is immutable.
builtinRule.meta.id = "forged/rule";
// @ts-expect-error public built-in rule implementations are immutable.
builtinRule.evaluate = () => [];
// @ts-expect-error reusable scanner functions are readonly.
htmlScanner.scan = () => report;
// @ts-expect-error reusable scanner functions are readonly.
domScanner.scan = () => report;

console.log(
  findings.length,
  requiredCapabilities.length,
  reusableFirst.rulePacks?.length,
  reusableSecond.rulePacks?.length,
  taxonomy.pageContexts.length,
  typeof domScanner.scan,
);
