import {
  createScanner,
  fairuxBuiltinRulePack,
  ScannerPolicyError as RootScannerPolicyError,
} from "@fairux/sdk";
import { createHtmlScanner, ScannerPolicyError, scanHtml } from "@fairux/sdk/html";
import sdkManifest from "@fairux/sdk/package.json" with { type: "json" };
import { purchaseGuardRulePack } from "../sdk-custom-rule-pack/purchase-guard-pack.mjs";

const ruleOverrides = { "consent/checked-checkbox": false };
const configuredPacks = [fairuxBuiltinRulePack, purchaseGuardRulePack];
const scanner = createHtmlScanner({
  includeExperimental: true,
  rulePacks: configuredPacks,
  ruleOverrides,
  now: () => new Date("2026-01-01T00:00:00Z"),
});
const rootScanner = createScanner({
  includeExperimental: true,
  rulePacks: configuredPacks,
  now: () => new Date("2026-01-01T00:00:00Z"),
});
ruleOverrides["consent/checked-checkbox"] = true;

const contextSignal = { context: "purchase-guard/checkout-form", confidence: "high" };
const checkoutFormHtml = "<main><form><input name='email'><button>Buy now</button></form></main>";
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
class PackedRootDocument {
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
const rootDocument = new PackedRootDocument([contextSignal]);
Object.defineProperty(rootDocument, "unrelated", {
  enumerable: true,
  configurable: true,
  get() {
    throw new Error("root scanner enumerated an unrelated document getter");
  },
});
const rootContext = rootScanner.scan(rootDocument);

if (first.rulePacks?.length !== 2 || second.rulePacks?.length !== 2) {
  throw new Error("expected provenance for two rule packs");
}
if (JSON.stringify(first.rulePacks) !== JSON.stringify(second.rulePacks)) {
  throw new Error("expected reusable scanner provenance to stay stable");
}
if (first.findings.some((finding) => finding.ruleId === "consent/checked-checkbox")) {
  throw new Error("expected ruleOverrides false to stay snapshotted");
}
if (
  !second.findings.some(
    (finding) =>
      finding.ruleId === "purchase-guard/missing-return-policy" &&
      finding.category === "purchase-guard/return-policy",
  )
) {
  throw new Error("expected custom Purchase Guard finding");
}
if (
  !scanner.taxonomy.categories.some((category) => category.id === "purchase-guard/return-policy")
) {
  throw new Error("expected scanner taxonomy category metadata");
}
if (
  !scanner.taxonomy.pageContexts.some((context) => context.id === "purchase-guard/checkout-form")
) {
  throw new Error("expected scanner taxonomy page context metadata");
}
if (
  !reusableContext.findings.some(
    (finding) => finding.ruleId === "purchase-guard/checkout-form-return-policy",
  )
) {
  throw new Error("expected reusable scanner context-gated finding");
}
if (
  !oneShotContext.findings.some(
    (finding) => finding.ruleId === "purchase-guard/checkout-form-return-policy",
  )
) {
  throw new Error("expected one-shot context-gated finding");
}
if (
  !rootContext.findings.some(
    (finding) => finding.ruleId === "purchase-guard/checkout-form-return-policy",
  )
) {
  throw new Error("expected root scanner context-gated finding");
}
try {
  scanner.scan(checkoutFormHtml, {
    pageContexts: [{ context: "purchase-guard/undeclared-form", confidence: "high" }],
  });
  throw new Error("undeclared context was accepted");
} catch (error) {
  if (!(error instanceof ScannerPolicyError)) throw error;
}
try {
  rootScanner.scan(
    new PackedRootDocument([{ context: "purchase-guard/undeclared-form", confidence: "high" }]),
  );
  throw new Error("root scanner accepted undeclared context");
} catch (error) {
  if (!(error instanceof RootScannerPolicyError)) throw error;
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
    reusable: true,
    taxonomyCategories: scanner.taxonomy.categories.length,
    taxonomyPageContexts: scanner.taxonomy.pageContexts.length,
    contextFindings:
      reusableContext.summary.total + oneShotContext.summary.total + rootContext.summary.total,
  }),
);
