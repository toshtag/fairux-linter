# RulePack authoring

This guide is for external authors building a RulePack with `@fairux/sdk`.
Use the SDK entry points as the public contract. Do not import `@fairux/core`, `@fairux/rules`,
`@fairux/html`, `@fairux/dom`, or source files under `packages/*/src`.

RulePacks are trusted executable JavaScript. FairUX validates pack shape and report output, but it
does not sandbox third-party code.

## Minimal RulePack

```ts
import type { RulePack } from "@fairux/sdk";

export const minimalRulePack = {
  meta: {
    id: "example/minimal-pack",
    version: "0.1.0",
    engineApiVersion: "1",
    title: "Minimal pack",
    status: "stable",
  },
  rules: [
    {
      meta: {
        id: "example/minimal-button",
        title: "Minimal button",
        category: "obstruction",
        defaultSeverity: "info",
        defaultConfidence: "low",
        defaultEnabled: true,
        tags: [],
        version: "1.0.0",
      },
      evaluate(doc, ctx) {
        return doc.findAll((node) => node.tag === "button").map((node) =>
          ctx.createFinding({
            evidence: [{ locator: node.locator, text: node.subtreeText }],
            description: "A button was found in the scanned content.",
            whyItMatters: "This demonstrates the smallest RulePack shape.",
            recommendation: "Replace this rule with a specific UX-risk signal.",
          }),
        );
      },
    },
  ],
} satisfies RulePack;
```

## Namespaced Categories

Built-in categories such as `consent`, `hidden-cost`, and `obstruction` do not need declarations.
External categories must be declared in `RulePack.taxonomy.categories`.

For a scoped npm-style pack ID such as `@purchase-guard/jp-commerce`, the taxonomy namespace is
`purchase-guard/...`.

```ts
export const purchaseGuardRulePack = {
  meta: {
    id: "@purchase-guard/jp-commerce",
    version: "0.1.0",
    engineApiVersion: "1",
    title: "Purchase Guard JP Commerce",
    status: "experimental",
  },
  taxonomy: {
    categories: [
      {
        id: "purchase-guard/return-policy",
        title: "Return policy",
        parentId: "hidden-cost",
      },
    ],
  },
  rules: [
    {
      meta: {
        id: "purchase-guard/missing-return-policy",
        title: "Missing return policy",
        category: "purchase-guard/return-policy",
        defaultSeverity: "low",
        defaultConfidence: "medium",
        defaultEnabled: true,
        tags: ["purchase-guard"],
        version: "1.0.0",
      },
      evaluate() {
        return [];
      },
    },
  ],
} satisfies RulePack;
```

Category parents may reference a built-in category or a category declared in the same RulePack.
Cross-pack external parents are rejected because they make composition order and ownership unclear.

## Page Contexts

External page contexts are declared in `RulePack.taxonomy.pageContexts`, then supplied by the
scanner caller. They are not automatically inferred by the declaration.

```ts
taxonomy: {
  pageContexts: [
    {
      id: "purchase-guard/checkout-form",
      title: "Checkout form",
    },
  ],
},
rules: [
  {
    meta: {
      id: "purchase-guard/checkout-form-return-policy",
      title: "Checkout form missing return policy",
      category: "purchase-guard/return-policy",
      defaultSeverity: "low",
      defaultConfidence: "medium",
      defaultEnabled: true,
      appliesTo: ["purchase-guard/checkout-form"],
      tags: ["purchase-guard"],
      version: "1.0.0",
    },
    evaluate(doc, ctx) {
      const contexts = ctx.getPageContexts();
      // The scanner has already filtered this rule to the declared page context.
      return contexts.length > 0 ? [] : [];
    },
  },
],
```

## Dictionaries

Dictionaries are locale-keyed groups of stateless regular expressions. Locale keys use deterministic
RFC 5646 syntax validation. That validates the tag shape only; it does not prove that your
dictionary has coverage for that locale.

```ts
dictionary: {
  en: {
    returnPolicy: [/return policy/i, /refund/i],
  },
  "ja-JP": {
    returnPolicy: [/返品/, /返金/],
  },
},
```

Do not use `/g` or `/y` regular expressions. Those flags are stateful and composition rejects them.

## Composition

Compose external packs with the built-in pack through the SDK root:

```ts
import { composeRulePacks, fairuxBuiltinRulePack } from "@fairux/sdk";
import { purchaseGuardRulePack } from "./src/index.js";

const composed = composeRulePacks([fairuxBuiltinRulePack, purchaseGuardRulePack], {
  includeExperimental: true,
});
```

`RulePack.taxonomy` is optional input metadata. `composeRulePacks().taxonomy` and
`scanner.taxonomy` are normalized output snapshots with required `categories` and `pageContexts`
arrays.

## HTML Scans

Use `scanHtml()` for one-shot scans:

```ts
import { fairuxBuiltinRulePack } from "@fairux/sdk";
import { scanHtml } from "@fairux/sdk/html";

const report = scanHtml(html, {
  includeExperimental: true,
  rulePacks: [fairuxBuiltinRulePack, purchaseGuardRulePack],
  pageContexts: [{ context: "purchase-guard/checkout-form", confidence: "high" }],
  now: () => new Date("2026-01-01T00:00:00Z"),
});
```

Use `createHtmlScanner()` when policy and RulePack composition are reused:

```ts
import { createHtmlScanner } from "@fairux/sdk/html";

const scanner = createHtmlScanner({
  includeExperimental: true,
  rulePacks: [fairuxBuiltinRulePack, purchaseGuardRulePack],
});

const report = scanner.scan(html, {
  file: "checkout.html",
  pageContexts: [{ context: "purchase-guard/checkout-form", confidence: "high" }],
});
```

## DOM Scans

Use `@fairux/sdk/dom` for browser-like documents:

```ts
import { createDomScanner } from "@fairux/sdk/dom";

const scanner = createDomScanner({
  includeExperimental: true,
  rulePacks: [fairuxBuiltinRulePack, purchaseGuardRulePack],
});

const report = scanner.scan(document, {
  pageContexts: [{ context: "purchase-guard/checkout-form", confidence: "high" }],
});
```

Do not inject arbitrary third-party RulePack code into a browser extension. Bundle reviewed,
version-pinned packs only.

## Rule Overrides

Rule IDs are validated against the configured RulePacks. Include your custom pack before overriding
its rule IDs.

```ts
const report = scanHtml(html, {
  rulePacks: [fairuxBuiltinRulePack, purchaseGuardRulePack],
  ruleOverrides: {
    "purchase-guard/missing-return-policy": { severity: "medium" },
  },
});
```

`severityOverrides` only changes severity. It does not enable or disable a rule.

## Validation Errors

RulePack authoring errors throw `RulePackError`. Common causes:

- duplicate pack or rule IDs;
- external categories or page contexts used without taxonomy declarations;
- namespace mismatch between pack ID and taxonomy ID;
- category parent cycles;
- invalid RFC 5646 locale syntax;
- sparse arrays;
- inherited metadata, class instances, unknown fields, or symbol keys;
- malformed findings returned by `evaluate()`.

Read the field path in the error message first. It points to the invalid metadata or output value.
See [RulePack testing](rule-pack-testing.md) for fixture-based negative tests.

## Deterministic Authoring Checklist

Rules must return the same findings for the same normalized document, policy, locale, and rule
version.

Avoid:

- implicit `Date.now()`;
- `Math.random()`;
- host-locale-dependent sorting;
- mutable global state;
- implicit network requests;
- run-dependent finding IDs;
- iteration over external data with unstable order.

If a rule needs time, use scanner-provided policy when the public context supports it. The current
rule context does not expose `now` directly, so do not author time-dependent third-party rules yet.

## Finding Language

Do not describe findings as legal, fraud, safety, or compliance verdicts. Avoid words such as
`illegal`, `fraudulent`, `malicious`, `safe`, `compliant`, or `verified seller`.

Prefer scoped language:

- "was not found in the scanned content";
- "may require human review";
- "this scan did not inspect linked pages";
- "this is a UX risk signal, not a legal or fraud verdict".

For missing-copy rules, state the scan boundary:

Bad: "The merchant has no return policy."

Good: "No return-policy text or link was found in the scanned checkout content."

## Trust Boundary

FairUX validates public data contracts, but third-party RulePacks are executable dependencies. Pin
versions, review source, keep lockfile integrity, and avoid dynamic downloads. FairUX is not a
sandbox for untrusted RulePack code or untrusted file trees.

## Publishing Checklist

Before publishing an external RulePack package:

- import only public SDK entry points;
- declare every external category and page context;
- add positive and negative tests for every rule;
- test composition with `fairuxBuiltinRulePack`;
- run HTML and DOM scans if you support both;
- document the trust boundary and product boundary;
- pin `@fairux/sdk` to a reviewed beta or stable version;
- verify a clean install from the packed package.

Use [examples/rule-pack-author](../examples/rule-pack-author) as the copyable package shape and
[tests/fixtures/sdk-custom-rule-pack](../tests/fixtures/sdk-custom-rule-pack) as fixture references.

## Versioning And Migration

Pack version and rule version have different jobs.

The pack version describes the package-level contract: exported pack metadata, taxonomy, bundled
rules, and dictionary content. A rule version describes that rule's detection behavior and finding
language. Update the rule version when behavior changes even if the pack version also changes.

For the beta taxonomy migration notes, see
[RulePack taxonomy beta.1 migration](migrations/rule-pack-taxonomy-beta.1.md).
For the beta governance metadata migration notes, see
[Rule governance beta.1 migration](migrations/rule-governance-beta.1.md).
