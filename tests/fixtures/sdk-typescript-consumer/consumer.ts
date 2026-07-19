import {
  type ComposedTaxonomy,
  type Finding,
  fairuxBuiltinRulePack,
  type RulePack,
} from "@fairux/sdk";
import { createDomScanner } from "@fairux/sdk/dom";
import { createHtmlScanner, type PageContextInputSignal, scanHtml } from "@fairux/sdk/html";
import { purchaseGuardRulePack } from "./custom-pack.js";

const configuredPacks: readonly RulePack[] = [fairuxBuiltinRulePack, purchaseGuardRulePack];
const suppliedPageContexts: readonly PageContextInputSignal[] = [
  { context: "purchase-guard/checkout-form", confidence: "high" },
];
const htmlScanner = createHtmlScanner({
  rulePacks: configuredPacks,
  ruleOverrides: { "consent/checked-checkbox": false },
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
const reusableContext = htmlScanner.scan(
  "<html><body><form><input name='email'><button>Buy now</button></form></body></html>",
  { file: "checkout.html", pageContexts: suppliedPageContexts },
);

const report = scanHtml("<html><body><button>Buy now</button></body></html>", {
  rulePacks: configuredPacks,
  now: () => new Date("2026-01-01T00:00:00Z"),
});
const oneShotContext = scanHtml(
  "<html><body><form><input name='email'><button>Buy now</button></form></body></html>",
  {
    rulePacks: configuredPacks,
    pageContexts: suppliedPageContexts,
    now: () => new Date("2026-01-01T00:00:00Z"),
  },
);

const findings: readonly Finding[] = report.findings;
const domScanner = createDomScanner();
const builtinRule = fairuxBuiltinRulePack.rules[0];
const builtinDictionary = fairuxBuiltinRulePack.dictionary;

if (!builtinRule) {
  throw new Error("Expected the built-in rule pack to include at least one rule.");
}
if (!builtinDictionary) {
  throw new Error("Expected the built-in rule pack to include a dictionary.");
}

// @ts-expect-error public built-in rule metadata is immutable.
builtinRule.meta.id = "forged/rule";
// @ts-expect-error public built-in rule tags are immutable.
builtinRule.meta.tags.push("forged-tag");
// @ts-expect-error public built-in rule implementations are immutable.
builtinRule.evaluate = () => [];
// @ts-expect-error dictionary locale entries are readonly.
builtinDictionary.en = {};
// @ts-expect-error reusable scanner functions are readonly.
htmlScanner.scan = () => report;
// @ts-expect-error reusable scanner functions are readonly.
domScanner.scan = () => report;

console.log(
  findings.length,
  reusableFirst.rulePacks?.length,
  reusableSecond.rulePacks?.length,
  reusableContext.findings.length,
  oneShotContext.findings.length,
  taxonomy.pageContexts.length,
  typeof domScanner.scan,
);
