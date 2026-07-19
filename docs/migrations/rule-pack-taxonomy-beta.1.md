# RulePack taxonomy beta.1 migration

This migration applies to external RulePack authors moving to `@fairux/sdk@0.1.0-beta.1`.

## What Changed

RulePacks can now declare external taxonomy metadata:

- `RulePack.taxonomy.categories`
- `RulePack.taxonomy.pageContexts`

The input `RulePack.taxonomy` field is optional, but composition output is normalized:
`composeRulePacks().taxonomy` and `scanner.taxonomy` always contain `categories` and
`pageContexts` arrays.

## Category Rules

Built-in categories are unchanged and do not need declarations:

- `consent`
- `subscription`
- `cancellation`
- `scarcity`
- `hidden-cost`
- `visual-asymmetry`
- `privacy`
- `accessibility`
- `obstruction`

External categories are required to be namespaced and declared before rules use them:

```ts
taxonomy: {
  categories: [{ id: "purchase-guard/return-policy", title: "Return policy" }],
},
rules: [
  {
    meta: {
      id: "purchase-guard/missing-return-policy",
      category: "purchase-guard/return-policy",
      // ...
    },
    evaluate() {
      return [];
    },
  },
],
```

For scoped npm package IDs, namespace ownership drops the npm scope marker:
`@purchase-guard/jp-commerce` owns `purchase-guard/...`.

External category parents may reference only:

- a built-in category;
- another external category declared in the same RulePack.

Cross-pack external parents are rejected.

## Page Context Rules

External page contexts must be declared before a rule can use them in `appliesTo`.

```ts
taxonomy: {
  pageContexts: [{ id: "purchase-guard/checkout-form", title: "Checkout form" }],
},
```

Caller-supplied page contexts are not automatic inference. A scanner caller must still pass them per
scan:

```ts
scanHtml(html, {
  rulePacks: [purchaseGuardRulePack],
  pageContexts: [{ context: "purchase-guard/checkout-form", confidence: "high" }],
});
```

Supplying an undeclared external page context fails at the scanner boundary.

## Locale Validation

Scanner locale values and dictionary locale keys use deterministic RFC 5646 syntax validation.
This is syntax validation only. It does not prove locale coverage, phrase quality, or IANA registry
membership.

## Trust Boundary

RulePacks are trusted executable JavaScript. FairUX validates metadata and finding output, but it
does not sandbox `evaluate()`. Review source, pin versions, and do not dynamically download unknown
packs.

## Migration Checklist

- Keep built-in categories unchanged.
- Add `taxonomy.categories` for every external category.
- Make external category IDs match your pack namespace.
- Keep external parents inside the same pack or point them to built-in categories.
- Add `taxonomy.pageContexts` for every external page context in `appliesTo`.
- Update tests to assert `RulePackError` for undeclared categories and page contexts.
- Update docs to avoid legal, fraud, safety, or compliance verdict language.
