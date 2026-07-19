# P13-T2: Extensible Taxonomy Contract

Status: Accepted

## Context

FairUX currently exposes closed unions for `Category`, `Locale`, and `PageContext`. That was a good
fit for the built-in dark-pattern rule pack, but it is too narrow for external RulePacks. A
consumer-protection pack, for example, should not have to classify missing return-policy evidence as
`hidden-cost` only because FairUX lacks a better built-in category.

The public contract must let external products add their own taxonomy without weakening the
deterministic FairUX core or changing the meaning of existing built-in category IDs.

## Decision

Keep the existing built-in category strings stable and introduce extensible IDs:

```ts
type BuiltinCategory =
  | "consent"
  | "subscription"
  | "cancellation"
  | "scarcity"
  | "hidden-cost"
  | "visual-asymmetry"
  | "privacy"
  | "accessibility"
  | "obstruction";

type CategoryId = BuiltinCategory | `${string}/${string}`;
```

`Category` remains as a compatibility alias for `CategoryId`. Public reports continue to emit
`finding.category` as a string. JSON, Markdown, and SARIF must preserve unknown external category
strings instead of mapping them into built-in FairUX categories.

RulePacks may declare taxonomy metadata:

```ts
interface CategoryDefinition {
  readonly id: CategoryId;
  readonly title: string;
  readonly description?: string;
  readonly parentId?: CategoryId;
}

interface PageContextDefinition {
  readonly id: PageContextId;
  readonly title: string;
  readonly description?: string;
}

interface RulePackTaxonomy {
  readonly categories?: readonly CategoryDefinition[];
  readonly pageContexts?: readonly PageContextDefinition[];
}
```

Rules may use built-in categories without redeclaring them. External categories must be declared in
the same RulePack taxonomy before any rule may reference them. External category parents may point
to a built-in category or another category declared by the same RulePack. Cross-pack parent
references are rejected until a future taxonomy dependency contract exists.

## Validation

RulePack composition rejects:

- duplicate category IDs within one pack or across composed packs;
- external rule categories that are not declared by the rule's own pack;
- invalid category IDs;
- namespaced category IDs whose namespace does not match the declaring pack namespace;
- external category `parentId` references outside the same RulePack;
- category parent cycles;
- duplicate page-context IDs within one pack or across composed packs;
- invalid page-context IDs;
- namespaced page-context IDs whose namespace does not match the declaring pack namespace;
- external `appliesTo` page contexts that are not declared by the rule's own pack.

The namespace is the segment before `/`. For npm scoped package IDs, the leading `@` is ignored and
the scope owns the namespace: `@purchase-guard/jp-commerce` owns `purchase-guard/...`. Built-in
FairUX IDs remain reserved and do not need to match a pack namespace.

## Locale

`Locale` is widened to `string` so public consumers can pass BCP 47 language tags whose syntax is
defined by RFC 5646, including `ja-JP`, `zh-Hant-TW`, extension-bearing tags such as
`en-u-ca-gregory`, private-use tags such as `x-private`, and grandfathered tags such as
`i-klingon`. FairUX validates locale syntax deterministically without host `Intl` support; this
does not imply locale coverage. Duplicate variant subtags are rejected case-insensitively, and
duplicate extension singletons are also rejected. FairUX does not validate IANA registry membership
or extlang prefix relationships in this task. The built-in dictionary still ships `en` and `ja`;
locale fallback is not expanded in this task. Until coverage metadata exists, unknown or unsupported
dictionaries should fail validation only when they are part of RulePack dictionary data. Future P16
work should report unsupported locale coverage explicitly instead of implying that unexecuted
locale-specific checks found no risk.

## Page Context

`PageContext` becomes a compatibility alias for `PageContextId`. Built-in context detection still
emits only the existing FairUX contexts and `unknown`. External page contexts can be declared and
used by external rules. HTML and DOM SDK scans may accept per-input page-context signals when those
contexts are declared by the configured RulePack taxonomy. FairUX does not infer external contexts
automatically in this task.

Page contexts are semantically unordered, but public rule APIs expose them in a canonical order for
determinism. Every scanner created through the public SDK validates and canonicalizes document
page-context signals at the scanner boundary. HTML and DOM input options are convenience producers
of the same core signal contract. `ctx.getPageContexts()` returns one signal per context, sorted by
context ID using UTF-16 code-unit ascending order. When adapter-detected and caller-supplied signals
contain the same context, the highest-confidence signal wins. Equal-confidence ties keep the first
signal; adapter signals are merged before caller-supplied signals, and duplicate caller signals keep
their first equal-confidence occurrence.

## Report Schema and SARIF

No schema version bump is required for category widening because the JSON field was already a string
in the serialized report. SARIF already stores `finding.category` under `properties.fairux.category`;
it must keep the external ID verbatim. Markdown should display category so external authors can
verify that their taxonomy survived serialization.

## Fingerprints

Finding fingerprints already include category. Existing built-in rule fingerprints must not change.
External categories will naturally influence fingerprints, which is desirable because moving a rule
between taxonomy categories changes the finding identity.

## Consequences

External products can model categories such as `purchase-guard/return-policy` without pretending
they are FairUX built-in hidden-cost findings. The tradeoff is stricter RulePack authoring: external
packs must declare taxonomy before rules can use it.
