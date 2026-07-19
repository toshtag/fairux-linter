# Rule governance beta.1 migration

This migration applies to external RulePack authors preparing for the first published
`@fairux/sdk` beta. It is a planned source-breaking beta contract change before npm publication.

## What changes

Every rule will need governance metadata:

- `maturity`
- `requiredCapabilities`
- `evidenceRequirements`
- optional `optionalCapabilities`
- optional `jurisdictions`
- optional `officialSources`
- optional `knownLimitations`
- optional `deprecation`

Required arrays must contain at least one item. Optional arrays may be omitted, but cannot be empty
when present.

## Capabilities

Use `requiredCapabilities` only for observations the rule needs to run correctly. Use
`optionalCapabilities` for observations that can improve precision in a future runtime.

Capability namespaces identify providers or vocabularies, not the RulePack that consumes them.
Your pack may refer to external provider capabilities such as `browser/computed-style` or
`purchase-flow/journey` without owning those namespaces.

## Jurisdictions

Use canonical jurisdiction IDs:

- `global`
- `EU`
- `EEA`
- uppercase ISO 3166-1 alpha-2 country codes from the SDK's frozen set
- namespaced external jurisdiction IDs

Do not use lowercase country codes, `UK` as an alias, ISO subdivisions, URLs, or free-form labels.
Jurisdiction metadata is review context only; it is not a legal conclusion.

## Official sources

`officialSources` are structured governance metadata. Use namespaced source IDs, absolute HTTPS
URLs without credentials, non-empty titles and publishers, and valid calendar `reviewedAt` dates.

Do not rely on `officialSources` becoming finding `references`. The existing `references` field
remains an unstructured finding reference contract and is not automatically populated from
`officialSources`.

## Deprecation

Deprecated rules require `deprecation`. `since` and `removalTarget` use strict semver. Replacement
rules must be built-in rules or rules in the same source RulePack, and they cannot point to the same
rule, a missing rule, a deprecated rule, or a replacement cycle.

Deprecation metadata alone does not change runtime enablement, experimental gating, rule IDs, rule
versions, or finding fingerprints.

## Public imports

External packages must import governance types from `@fairux/sdk`. `@fairux/core`, `@fairux/rules`,
and adapter implementation packages are internal compatibility boundaries for now.

## Release timing

This migration is acceptable before `@fairux/sdk` is published because the beta contract is still
being finalized. After the first npm publication, adding required RuleMeta fields must follow the
package semver policy and include migration notes.
