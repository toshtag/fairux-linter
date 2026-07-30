import { readFileSync } from "node:fs";
import {
  createScanner,
  fairuxBuiltinRulePack,
  ScannerPolicyError as RootScannerPolicyError,
} from "@fairux/sdk";
import { createHtmlScanner, ScannerPolicyError, scanHtml } from "@fairux/sdk/html";
import sdkManifest from "@fairux/sdk/package.json" with { type: "json" };
import { purchaseGuardRulePack } from "../sdk-custom-rule-pack/valid/purchase-guard-pack.mjs";

// Explicit, never inferred: `release` additionally holds the installed SDK to the repository's
// generated catalog — counts, specific sources, specific limitation text — which is only a true
// claim about an artifact packed from this checkout. `registry-consumer` asserts the public
// consumer contract alone, so a published SDK older than the checkout's catalog still passes.
const profile = process.env.FAIRUX_CONSUMER_SMOKE_PROFILE ?? "release";
if (profile !== "release" && profile !== "registry-consumer") {
  throw new Error(`unknown consumer smoke profile: ${JSON.stringify(profile)}`);
}
// A file read, not an import: the registry-consumer harness does not copy the catalog in, this
// fixture is held to static imports only, and a static import would make the catalog's absence a
// module-load crash instead of a profile decision.
const expectedCatalog =
  profile === "release"
    ? JSON.parse(readFileSync(new URL("./rule-catalog.json", import.meta.url), "utf8"))
    : null;

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
const builtinRuntimeSources = fairuxBuiltinRulePack.rules.flatMap(
  (rule) => rule.meta.officialSources ?? [],
);
const checkedCheckboxRule = fairuxBuiltinRulePack.rules.find(
  (rule) => rule.meta.id === "consent/checked-checkbox",
);
const runtimeGovernanceContract = fairuxBuiltinRulePack.rules
  .map((rule) => ({
    id: rule.meta.id,
    maturity: rule.meta.maturity,
    defaultEnabled: rule.meta.defaultEnabled,
    experimental: rule.meta.experimental === true,
    requiredCapabilities: rule.meta.requiredCapabilities,
    optionalCapabilities: rule.meta.optionalCapabilities ?? [],
    evidenceRequirements: rule.meta.evidenceRequirements,
    jurisdictions: rule.meta.jurisdictions ?? [],
    officialSources: rule.meta.officialSources ?? [],
    knownLimitations: rule.meta.knownLimitations ?? [],
  }))
  .sort((left, right) => left.id.localeCompare(right.id));
const expectedGovernanceContract = expectedCatalog?.rules
  .map((rule) => ({
    id: rule.identity.id,
    maturity: rule.maturity,
    defaultEnabled: rule.execution.defaultEnabled,
    experimental: rule.execution.experimental === true,
    requiredCapabilities: rule.capabilities.required,
    optionalCapabilities: rule.capabilities.optional ?? [],
    evidenceRequirements: rule.evidenceRequirements,
    jurisdictions: rule.jurisdictions,
    officialSources: rule.runtimeOfficialSources,
    knownLimitations: rule.knownLimitations,
  }))
  .sort((left, right) => left.id.localeCompare(right.id));
const stableRules = runtimeGovernanceContract.filter((rule) => rule.maturity === "stable");
const experimentalRules = runtimeGovernanceContract.filter(
  (rule) => rule.maturity === "experimental",
);

if (first.rulePacks?.length !== 2 || second.rulePacks?.length !== 2) {
  throw new Error("expected provenance for two rule packs");
}
// Profile-independent governance invariants: rules exist, stay classified, and carry metadata.
// Counts, specific sources, and specific limitation text are release-only claims below.
if (runtimeGovernanceContract.length === 0 || stableRules.length === 0) {
  throw new Error("expected governed built-in rules with at least one stable rule");
}
if (experimentalRules.some((rule) => rule.defaultEnabled || !rule.experimental)) {
  throw new Error("expected experimental built-in rules to remain experimental and default-off");
}
for (const rule of runtimeGovernanceContract) {
  if (rule.requiredCapabilities.length === 0) {
    throw new Error(`expected requiredCapabilities for ${rule.id}`);
  }
  if (rule.evidenceRequirements.length === 0) {
    throw new Error(`expected evidenceRequirements for ${rule.id}`);
  }
}
if (profile === "release") {
  if (builtinRuntimeSources.length !== 30) {
    throw new Error(
      `expected 30 built-in runtime source mappings, got ${builtinRuntimeSources.length}`,
    );
  }
  if (runtimeGovernanceContract.length !== 13) {
    throw new Error(`expected 13 built-in rules, got ${runtimeGovernanceContract.length}`);
  }
  if (stableRules.length !== 11 || experimentalRules.length !== 2) {
    throw new Error(
      `expected 11 stable and 2 experimental built-in rules, got ${stableRules.length}/${experimentalRules.length}`,
    );
  }
  if (JSON.stringify(runtimeGovernanceContract) !== JSON.stringify(expectedGovernanceContract)) {
    throw new Error("built-in runtime governance contract does not match generated catalog");
  }
  if (
    builtinRuntimeSources.some((source) =>
      [
        "us/ftc-negative-option-2024-vacated-final-rule",
        "us/ftc-negative-option-2026-anprm",
      ].includes(source.id),
    )
  ) {
    throw new Error("non-current sources leaked into built-in runtime governance");
  }
  if (JSON.stringify(fairuxBuiltinRulePack.rules).includes("business-guidance/blog")) {
    throw new Error("generic FTC blog reference leaked into built-in runtime governance");
  }
  if (
    !checkedCheckboxRule?.meta.officialSources?.some(
      (source) => source.id === "us/ftc-dark-patterns-report",
    )
  ) {
    throw new Error("expected checked-checkbox built-in official source metadata");
  }
  if (
    checkedCheckboxRule.meta.knownLimitations?.[0] !==
    "A checked attribute may not match runtime state after scripts execute."
  ) {
    throw new Error("expected checked-checkbox built-in known limitations");
  }
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
    builtInGovernance: true,
    builtInRules: runtimeGovernanceContract.length,
    // Only the release profile compared the contract against the generated catalog, so only it
    // may report an exact comparison; JSON.stringify drops the field otherwise.
    builtInGovernanceExactRules:
      profile === "release" ? runtimeGovernanceContract.length : undefined,
    builtInRuntimeSources: builtinRuntimeSources.length,
    builtInStableRules: stableRules.length,
    builtInExperimentalRules: experimentalRules.length,
    contextFindings:
      reusableContext.summary.total + oneShotContext.summary.total + rootContext.summary.total,
  }),
);
