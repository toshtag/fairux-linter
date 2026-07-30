/**
 * The Node half of the v1 registry consumer contract.
 *
 * Runs only against a published `@fairux/sdk` installed from the public registry, and asserts only
 * the consumer contract that `0.1.0-beta.2` already publishes: entry points, RulePack composition
 * and provenance, findings, taxonomy immutability, mutation isolation, malformed-pack rejection,
 * and version identity. Nothing here reads this repository's generated catalog, counts its rules,
 * or names a specific built-in source or limitation — those are facts about a checkout, not about
 * the published SDK. Frozen with the rest of `sdk-registry-consumer-v1`: new SDK surface is proven
 * by a future v2 directory, never by editing this one.
 */
import { composeRulePacks, createScanner, fairuxBuiltinRulePack, RulePackError } from "@fairux/sdk";
import { createHtmlScanner, scanHtml } from "@fairux/sdk/html";
import sdkManifest from "@fairux/sdk/package.json" with { type: "json" };
import { purchaseGuardRulePack } from "./purchase-guard-pack.mjs";

const configuredPacks = [fairuxBuiltinRulePack, purchaseGuardRulePack];
const contextSignal = { context: "purchase-guard/checkout-form", confidence: "high" };
const checkoutFormHtml = "<main><form><input name='email'><button>Buy now</button></form></main>";

const scanner = createHtmlScanner({
  includeExperimental: true,
  rulePacks: configuredPacks,
  now: () => new Date("2026-01-01T00:00:00Z"),
});
const rootScanner = createScanner({
  includeExperimental: true,
  rulePacks: configuredPacks,
  now: () => new Date("2026-01-01T00:00:00Z"),
});

const rootInputNode = Object.freeze({
  id: "input",
  parentId: "form",
  tag: "input",
  attributes: { name: "email" },
  directText: "",
  subtreeText: "",
  normalizedText: "",
  children: [],
  locator: { type: "css", value: "input[name='email']" },
});
const rootButtonNode = Object.freeze({
  id: "button",
  parentId: "form",
  tag: "button",
  attributes: {},
  directText: "Buy now",
  subtreeText: "Buy now",
  normalizedText: "buy now",
  children: [],
  locator: { type: "css", value: "button" },
});
const rootFormNode = Object.freeze({
  id: "form",
  parentId: "root",
  tag: "form",
  attributes: {},
  directText: "",
  subtreeText: "Buy now",
  normalizedText: "buy now",
  children: [rootInputNode, rootButtonNode],
  locator: { type: "css", value: "form" },
});
const rootMainNode = Object.freeze({
  id: "root",
  tag: "main",
  attributes: {},
  directText: "",
  subtreeText: "Buy now",
  normalizedText: "buy now",
  children: [rootFormNode],
  locator: { type: "css", value: "main" },
});
class RootDocument {
  #nodes = [rootMainNode, rootFormNode, rootInputNode, rootButtonNode];
  root = rootMainNode;
  runtime = "html";
  metadata = { file: "root-consumer.html" };

  constructor(pageContexts) {
    this.pageContexts = pageContexts;
  }

  all() {
    return [...this.#nodes];
  }

  findAll(predicate) {
    return this.#nodes.filter(predicate);
  }

  getNode(id) {
    return this.#nodes.find((node) => node.id === id);
  }
}

const first = scanner.scan(
  '<main><label><input type="checkbox" checked> Send marketing offers</label><button>Buy now</button></main>',
  { file: "first.html" },
);
const second = scanner.scan("<main><button>Buy now</button></main>", { file: "second.html" });
const reusableContext = scanner.scan(checkoutFormHtml, {
  file: "checkout.html",
  pageContexts: [contextSignal],
});
const oneShotContext = scanHtml(checkoutFormHtml, {
  includeExperimental: true,
  rulePacks: configuredPacks,
  pageContexts: [contextSignal],
  now: () => new Date("2026-01-01T00:00:00Z"),
});
const rootContext = rootScanner.scan(new RootDocument([contextSignal]));

// Built-in and Purchase Guard findings, attributed rather than counted: a finding whose rule is
// not the contract pack's belongs to the built-in pack, whatever that pack ships today.
if (!first.findings.some((finding) => !finding.ruleId.startsWith("purchase-guard/"))) {
  throw new Error("expected a built-in finding");
}
if (
  !second.findings.some(
    (finding) =>
      finding.ruleId === "purchase-guard/missing-return-policy" &&
      finding.category === "purchase-guard/return-policy",
  )
) {
  throw new Error("expected the Purchase Guard finding");
}
for (const [label, report] of [
  ["reusable", reusableContext],
  ["one-shot", oneShotContext],
  ["root", rootContext],
]) {
  if (
    !report.findings.some(
      (finding) => finding.ruleId === "purchase-guard/checkout-form-return-policy",
    )
  ) {
    throw new Error(`expected the ${label} scanner context-gated finding`);
  }
}
if (first.rulePacks?.length !== 2 || second.rulePacks?.length !== 2) {
  throw new Error("expected provenance for two rule packs");
}
if (JSON.stringify(first.rulePacks) !== JSON.stringify(second.rulePacks)) {
  throw new Error("expected reusable scanner provenance to stay stable");
}
if (
  !scanner.taxonomy.categories.some((category) => category.id === "purchase-guard/return-policy")
) {
  throw new Error("expected the namespaced taxonomy category");
}
if (
  !scanner.taxonomy.pageContexts.some((context) => context.id === "purchase-guard/checkout-form")
) {
  throw new Error("expected the namespaced taxonomy page context");
}

// Governance metadata presence, not counts: every governed rule carries capabilities and evidence
// requirements, and rules classified experimental stay experimental and default-off.
const governedRules = fairuxBuiltinRulePack.rules.map((rule) => rule.meta);
const stableRules = governedRules.filter((meta) => meta.maturity === "stable");
if (governedRules.length === 0 || stableRules.length === 0) {
  throw new Error("expected governed built-in rules with at least one stable rule");
}
for (const meta of governedRules) {
  if (!meta.requiredCapabilities || meta.requiredCapabilities.length === 0) {
    throw new Error(`expected requiredCapabilities for ${meta.id}`);
  }
  if (!meta.evidenceRequirements || meta.evidenceRequirements.length === 0) {
    throw new Error(`expected evidenceRequirements for ${meta.id}`);
  }
  if (meta.maturity === "experimental" && (meta.defaultEnabled || meta.experimental !== true)) {
    throw new Error(`expected ${meta.id} to remain experimental and default-off`);
  }
}

const taxonomyFreezeChecks = {
  taxonomy: Object.isFrozen(scanner.taxonomy),
  categories: Object.isFrozen(scanner.taxonomy.categories),
  category: Object.isFrozen(scanner.taxonomy.categories[0]),
  pageContexts: Object.isFrozen(scanner.taxonomy.pageContexts),
  pageContext: Object.isFrozen(scanner.taxonomy.pageContexts[0]),
};
for (const [name, passed] of Object.entries(taxonomyFreezeChecks)) {
  if (!passed) throw new Error(`scanner taxonomy is not frozen: ${name}`);
}
const taxonomyTitle = scanner.taxonomy.categories[0]?.title;
purchaseGuardRulePack.taxonomy.categories[0].title = "Forged title";
purchaseGuardRulePack.taxonomy.pageContexts.push({
  id: "purchase-guard/forged-form",
  title: "Forged form",
});
if (scanner.taxonomy.categories[0]?.title !== taxonomyTitle) {
  throw new Error("scanner taxonomy changed after source RulePack mutation");
}
if (scanner.taxonomy.pageContexts.some((context) => context.id === "purchase-guard/forged-form")) {
  throw new Error("scanner taxonomy accepted source RulePack mutation");
}

const malformedRulePack = {
  meta: {
    id: "@purchase-guard/malformed",
    version: "1.0.0",
    engineApiVersion: "1",
    title: "Malformed registry consumer pack",
    status: "stable",
  },
  rules: [
    {
      meta: {
        id: "purchase-guard/malformed-rule",
        title: "Malformed rule",
        category: "obstruction",
        defaultSeverity: "info",
        defaultConfidence: "low",
        defaultEnabled: true,
        tags: [],
        version: "1.0.0",
        maturity: "stable",
        requiredCapabilities: [],
        evidenceRequirements: ["presence"],
      },
      evaluate() {
        return [];
      },
    },
  ],
};
let malformedPackRejected = false;
try {
  composeRulePacks([malformedRulePack], { includeExperimental: true });
} catch (error) {
  if (!(error instanceof RulePackError)) throw error;
  malformedPackRejected = true;
}
if (!malformedPackRejected) {
  throw new Error("expected the malformed pack to be rejected with RulePackError");
}

if (first.toolVersion !== sdkManifest.version || second.toolVersion !== sdkManifest.version) {
  throw new Error(
    `expected report.toolVersion ${sdkManifest.version}, got ${first.toolVersion}/${second.toolVersion}`,
  );
}

console.log(
  JSON.stringify({
    ok: true,
    findings:
      first.summary.total +
      second.summary.total +
      reusableContext.summary.total +
      oneShotContext.summary.total +
      rootContext.summary.total,
    toolVersion: first.toolVersion,
    taxonomyCategories: scanner.taxonomy.categories.length,
    taxonomyPageContexts: scanner.taxonomy.pageContexts.length,
    contextFindings:
      reusableContext.summary.total + oneShotContext.summary.total + rootContext.summary.total,
    governedRules: governedRules.length,
    stableRules: stableRules.length,
    frozen: true,
    mutationIsolated: true,
    malformedPackRejected: true,
  }),
);
