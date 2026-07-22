# Rule governance beta.1 migration

This migration applies to external RulePack authors preparing for the first published
`@fairux/sdk` beta. It is a planned source-breaking beta contract change before npm publication.

## What changes

Every RulePack rule accepted by composition will need governance metadata, including rules in an
experimental pack that is later excluded from execution:

- `maturity`
- `requiredCapabilities`
- `evidenceRequirements`
- optional `optionalCapabilities`
- optional `jurisdictions`
- optional `officialSources`
- optional `knownLimitations`
- optional `deprecation`

Required arrays must contain at least one item. Optional arrays may be omitted, but cannot be empty
when present. Governance metadata is validated before experimental-pack exclusion so invalid
metadata cannot be hidden behind `includeExperimental: false`.

## Capabilities

Use `requiredCapabilities` only for observations the rule needs to run correctly. Use
`optionalCapabilities` for observations that can improve precision in a future runtime.

Capability IDs identify observation contracts, not runtime providers. If a rule needs a built-in
semantic, use the built-in ID regardless of which provider may eventually supply it:
`computed-style`, `journey`, and `network` remain built-in IDs.

Do not create namespaced provider aliases for built-in capability meanings. Namespaced external
capabilities are only for new observation contracts that are not in the built-in vocabulary, such as
`browser/paint-order`, `design-system/semantic-prominence`, `host/consent-state`, or
`purchase-flow/checkout-stage-history`. Provider registration, provider IDs, and provenance are
separate P15 contracts.

## Jurisdictions

Use canonical jurisdiction IDs:

- `global`
- `EU`
- `EEA`
- uppercase ISO 3166-1 alpha-2 country codes from the SDK's frozen set
- namespaced external jurisdiction IDs

Do not use lowercase country codes, `UK` as an alias, ISO subdivisions, URLs, or free-form labels.
Jurisdiction metadata is review context only; it is not a legal conclusion.
Rule jurisdictions and official-source jurisdictions are not automatically unioned, intersected, or
treated as a subset of one another, and they must not be used to infer legal applicability.

## Official sources

`officialSources` are structured governance metadata. Use namespaced source IDs, absolute HTTPS
URLs without credentials, non-empty titles and publishers, and valid calendar `reviewedAt` dates.
Titles, publishers, and other human-readable governance strings cannot have leading or trailing
whitespace.

Source identity fields are `id`, `title`, `publisher`, and canonical URL. Review fields are
`reviewedAt` and `jurisdictions`. The canonical URL is exactly `new URL(input).href`; the SDK does
not add custom query, fragment, case, or trailing-slash normalization beyond the platform URL
parser. The same source ID may appear more than once in a RulePack only when the identity fields
match exactly after URL canonicalization. Review fields may differ per rule. Different RulePacks may
reuse the same source ID without creating a composition conflict.

Do not rely on `officialSources` becoming finding `references`. The existing `references` field
remains an unstructured finding reference contract and is not automatically populated from
`officialSources`.

## Deprecation

Deprecated rules require `deprecation`. `since` and `removalTarget` use strict semver in the
containing RulePack version lineage, not the SDK version, rule version, or `engineApiVersion`.
Validation requires `since <= pack.meta.version`; when `removalTarget` is present, validation also
requires `pack.meta.version < removalTarget` and `since < removalTarget`.

Replacement rules must be rules in the same unfiltered source RulePack. External packs cannot point
to built-in rules or to rules in another external pack until a future RulePack dependency contract
defines that relationship. Replacement rules also cannot point to the same rule, a missing rule, a
deprecated rule, or a replacement cycle.

Deprecation metadata alone does not change runtime enablement, experimental gating, rule IDs, rule
versions, or finding fingerprints.

Stable RulePacks may contain stable, opt-in experimental, and deprecated rules; they must reject
draft rules. Experimental RulePacks may contain draft, experimental, stable, and deprecated rules.
Deprecated rules may preserve their previous runtime gate, so both deprecated experimental rules and
deprecated non-experimental rules are valid when their other metadata is valid.

## Public imports

External packages must import governance authoring types from the `@fairux/sdk` root. `@fairux/core`,
`@fairux/rules`, adapter implementation packages, SDK subpaths, and source files under
`packages/*/src` are not the canonical authoring contract.

## Release timing

This migration is acceptable before `@fairux/sdk` is published because the beta contract is still
being finalized. After the first npm publication, adding required RuleMeta fields must follow the
package semver policy and include migration notes.
