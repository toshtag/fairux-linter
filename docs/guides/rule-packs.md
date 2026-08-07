# Authoring a RulePack

This guide is for external authors building a RulePack with `@fairux/sdk`.
Use the SDK entry points as the public contract. Import RulePack and governance authoring types from
the `@fairux/sdk` root. Do not import `@fairux/core`, `@fairux/rules`, `@fairux/html`,
`@fairux/dom`, SDK subpaths for authoring types, or source files under `packages/*/src`.

RulePacks are trusted executable JavaScript. FairUX validates pack shape and report output, but it
does not sandbox third-party code.

## A minimal RulePack

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
        maturity: "stable",
        requiredCapabilities: ["structure", "text"],
        evidenceRequirements: ["presence"],
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

## Namespaced categories

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
        maturity: "stable",
        requiredCapabilities: ["structure", "text"],
        evidenceRequirements: ["absence", "text-match"],
        knownLimitations: ["Linked policy pages are not fetched by this rule."],
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

## Page contexts

Scoping a rule with `appliesTo` makes it silent everywhere the context does not fire, and a rule that
never runs reports nothing — which reads exactly like a page with nothing wrong. What triggers each
**built-in** context is `PAGE_CONTEXT_KEYWORDS`, exported from `@fairux/sdk`, so the choice is
checkable rather than guessed:

```ts
import { PAGE_CONTEXT_KEYWORDS } from "@fairux/sdk";
PAGE_CONTEXT_KEYWORDS.subscription; // ["subscribe", "subscription", "free trial", …]
```

Detection is deliberately fuzzy and low-stakes: a phrase in the `<title>` scores `high`, one in the
body scores `medium`, and a miss leaves the rule quiet rather than producing a wrong finding.

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
      maturity: "stable",
      requiredCapabilities: ["structure", "text"],
      evidenceRequirements: ["absence", "text-match"],
      knownLimitations: ["Only caller-supplied page-context signals are evaluated."],
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

## HTML scans

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

## DOM scans

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

## Rule overrides

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

## Governance metadata

Every rule accepted by RulePack composition needs governance metadata: maturity, required
capabilities, evidence requirements, optional capabilities, jurisdictions, official sources, known
limitations, and deprecation metadata where applicable. The contract is the `RuleMeta` type exported
from `@fairux/sdk`, enforced by RulePack validation — see [rule governance](../reference/rule-metadata.md).

Capability IDs name observation contracts, not provider instances. Use built-in capability IDs for
built-in semantics regardless of provider: `computed-style`, `journey`, and `network` are built-in
IDs. Do not create namespaced provider aliases for built-in capability meanings. Namespaced
external capabilities are only for new observation contracts such as `browser/paint-order`,
`design-system/semantic-prominence`, `host/consent-state`, or
`purchase-flow/checkout-stage-history`.

Stable packs may contain stable, opt-in experimental, and deprecated rules, but not draft rules.
Experimental packs may contain draft, experimental, stable, and deprecated rules. Draft and
experimental rules are opt-in with `experimental: true` and `defaultEnabled: false`. Deprecated
rules may preserve their previous runtime gate, including both deprecated experimental rules and
deprecated non-experimental rules.

## Validation errors

RulePack authoring errors throw `RulePackError`. Common causes:

- duplicate pack or rule IDs;
- external categories or page contexts used without taxonomy declarations;
- namespace mismatch between pack ID and taxonomy ID;
- category parent cycles;
- invalid RFC 5646 locale syntax;
- missing or invalid governance metadata;
- sparse arrays;
- inherited metadata, class instances, unknown fields, or symbol keys;
- malformed findings returned by `evaluate()`.

Read the field path in the error message first. It points to the invalid metadata or output value.
See [Testing](#testing) below for fixture-based negative tests.

## Deterministic authoring checklist

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

## Finding language

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

## Trust boundary

FairUX validates public data contracts, but third-party RulePacks are executable dependencies. Pin
versions, review source, keep lockfile integrity, and avoid dynamic downloads. FairUX is not a
sandbox for untrusted RulePack code or untrusted file trees.

## Journey rules

A rule that needs more than one page goes in `journeyRules` rather than `rules`:

```ts
const offerChanged: JourneyRule = {
  meta: {
    id: "acme/offer-changed",
    // ... the same governance metadata every rule carries
    requiredCapabilities: ["journey", "text"],
    evidenceRequirements: ["sequence"],
  },
  evaluate(journey, ctx) {
    const first = journey.steps[0];
    const later = journey.steps.slice(1).find((step) => differs(step, first));
    if (!first || !later) return [];
    return [
      ctx.createFinding({
        stepId: later.id, // required: a finding with no step cannot be acted on
        evidence: [
          { text: summarize(first), stepId: first.id },
          { text: summarize(later) },
        ],
        description: "What the flow offered changed between steps.",
        whyItMatters: "A commitment made on one screen is not the one the next screen honours.",
        recommendation: "Keep the offer consistent across the flow.",
      }),
    ];
  },
};
```

What the composer enforces:

- **`journey` must be in `requiredCapabilities`.** A rule that does not need the flow is an ordinary
  rule, and running it over the whole journey would report one page's problem as the flow's.
- **Ids share one namespace with `rules`.** A config override, an `explain`, and a suppression all
  address a rule by id and none of them asks which kind it is.
- **`journeyRules` must not be present and empty.** Absent already says that.

And one your rule has to keep: **do not re-report a single step's problem**. That layer is already
covered by the step's own report, and duplicating it makes one issue read as two.

To run one: `fairux scan-journey flow.json --rule-pack ./your-pack.mjs`, with a journey file whose
shape is in [the report schema](../reference/report-schema.md#the-journey-file-the-cli-reads). `fairux
rules --rule-pack ./your-pack.mjs` lists your journey rules in their own section — a `scan` never
runs them, so they are not in the count beside it.

## Testing

Test the same contract a production scanner uses: `composeRulePacks()`, `scanHtml()`, reusable
scanners, and DOM scans from `@fairux/sdk`. This repository's own authoring fixtures are under
[`tests/fixtures/sdk-custom-rule-pack`](../../tests/fixtures/sdk-custom-rule-pack) — the valid ones
compose and scan, the invalid ones must fail with `RulePackError`.

### A test shape that covers the real contract

```ts
import { describe, expect, it } from "vitest";
import { composeRulePacks, fairuxBuiltinRulePack, RulePackError } from "@fairux/sdk";
import { scanHtml } from "@fairux/sdk/html";
import { purchaseGuardRulePack } from "../src/index.js";

describe("purchaseGuardRulePack", () => {
  it("composes with the built-in pack", () => {
    const composed = composeRulePacks([fairuxBuiltinRulePack, purchaseGuardRulePack], {
      includeExperimental: true,
    });

    expect(composed.taxonomy.categories.map((category) => category.id)).toContain(
      "purchase-guard/return-policy",
    );
  });

  it("scans scoped checkout content", () => {
    const report = scanHtml("<main><form><input><button>Buy now</button></form></main>", {
      includeExperimental: true,
      rulePacks: [fairuxBuiltinRulePack, purchaseGuardRulePack],
      pageContexts: [{ context: "purchase-guard/checkout-form", confidence: "high" }],
    });

    expect(report.findings.map((finding) => finding.ruleId)).toContain(
      "purchase-guard/missing-return-policy",
    );
  });

  it("rejects undeclared external categories", () => {
    expect(() =>
      composeRulePacks([{ ...purchaseGuardRulePack, taxonomy: undefined }]),
    ).toThrow(RulePackError);
  });
});
```

### Valid fixtures

Cover at least:

- a minimal pack using a built-in category;
- a namespaced taxonomy category;
- an external page context with caller-supplied scan context;
- dictionary groups for every claimed locale;
- a Purchase Guard-style pack that stays outside FairUX product boundaries.

### Invalid fixtures

Cover at least:

- duplicate rule IDs;
- undeclared external categories;
- wrong namespace ownership;
- category parent cycles;
- undeclared external page contexts;
- invalid locale tags;
- sparse arrays;
- inherited metadata or class-backed metadata;
- malformed findings returned by `evaluate()`.

Invalid tests are as important as positive tests. They prove that authoring mistakes fail before
they become unstable public reports.

### Prove it against a packed tarball

Local workspace tests can accidentally pass by importing source files. Before publishing, verify a
packed tarball in a clean project:

```bash
pnpm pack
mkdir /tmp/my-rule-pack-smoke
cd /tmp/my-rule-pack-smoke
npm init -y
npm install /path/to/your-rule-pack.tgz @fairux/sdk@next
```

Then run a small root, HTML, DOM, and TypeScript consumer test against the installed package.
The FairUX SDK release workflow uses the same exact-tarball principle for `@fairux/sdk`.

This repository also verifies the copyable authoring example itself:

```bash
pnpm test:rule-pack-author-example
```

That command packs `@fairux/sdk`, installs it into a temporary copy of
`examples/rule-pack-author`, and runs the example package's own `build` and `test` scripts without
falling back to workspace source imports.

## Publishing checklist

Before publishing an external RulePack package:

- import only public SDK entry points;
- declare every external category and page context;
- add positive and negative tests for every rule;
- test composition with `fairuxBuiltinRulePack`;
- run HTML and DOM scans if you support both;
- document the trust boundary and product boundary;
- pin `@fairux/sdk` to a reviewed beta or stable version;
- verify a clean install from the packed package.

Use [examples/rule-pack-author](../../examples/rule-pack-author) as the copyable package shape and
[tests/fixtures/sdk-custom-rule-pack](../../tests/fixtures/sdk-custom-rule-pack) as fixture references.


## Versioning and migration

Pack version and rule version have different jobs.

The pack version describes the package-level contract: exported pack metadata, taxonomy, bundled
rules, and dictionary content. A rule version describes that rule's detection behavior and finding
language. Update the rule version when behavior changes even if the pack version also changes.

Nothing published has broken yet, so there is no migration guide. The rules that would go in one —
what may change additively and what costs a version — are in
[compatibility and deprecation](../reference/compatibility.md).
