---
id: P13-T1
title: "Rule governance metadata contract"
status: accepted
date: 2026-07-19
---

# ADR P13-T1: Rule Governance Metadata Contract

## Context

FairUX rules currently expose enough metadata to run deterministic scans and serialize findings:
rule ID, title, category, severity, confidence, tags, version, page-context filters, and references.
That is not enough for a public RulePack ecosystem. External authors and downstream products need to
understand a rule's maturity, observation capabilities, evidence expectations, jurisdictional review
context, source review state, limitations, and deprecation lifecycle before the SDK beta is
published.

These fields are governance metadata. They do not prove that a page is legal, illegal, fair,
unsafe, or fraudulent. They also do not mean FairUX has implemented runtime coverage for every
capability named by a rule.

P13-T8 hardens this accepted ADR before P13-T6 implements public types and validation. It does not
change runtime behavior, SARIF output, built-in rules, package versions, SDK tags, npm publication,
or GitHub Releases.

P13-T9 closes the remaining implementation blockers before P13-T6. It keeps the work docs-only and
does not add TypeScript types, validators, SARIF metadata, built-in rule metadata, SDK tags, npm
publication, or GitHub Releases.

## Decision

Rule governance metadata will be added to `RuleMeta` before the SDK beta becomes the stable public
authoring contract:

```ts
export type RuleMaturity = "draft" | "experimental" | "stable" | "deprecated";

export type BuiltinCapabilityId =
  | "structure"
  | "text"
  | "attributes"
  | "source-location"
  | "dom-state"
  | "style-hints"
  | "computed-style"
  | "viewport"
  | "interaction"
  | "journey"
  | "form"
  | "network";

export type CapabilityId = BuiltinCapabilityId | `${string}/${string}`;

export type EvidenceRequirement =
  | "presence"
  | "absence"
  | "text-match"
  | "attribute-state"
  | "comparison"
  | "runtime-state"
  | "sequence"
  | "network-observation";

export type ReadonlyNonEmptyArray<T> = readonly [T, ...T[]];

export type JurisdictionId = string;
export type OfficialSourceId = `${string}/${string}`;

export interface OfficialSource {
  readonly id: OfficialSourceId;
  readonly title: string;
  readonly publisher: string;
  readonly url: string;
  readonly jurisdictions?: ReadonlyNonEmptyArray<JurisdictionId>;
  readonly reviewedAt: string;
}

export interface RuleDeprecation {
  readonly since: string;
  readonly reason: string;
  readonly replacementRuleId?: string;
  readonly removalTarget?: string;
}
```

`RuleMeta` will gain these governance fields:

```ts
export interface RuleMeta {
  readonly maturity: RuleMaturity;
  readonly requiredCapabilities: ReadonlyNonEmptyArray<CapabilityId>;
  readonly optionalCapabilities?: ReadonlyNonEmptyArray<CapabilityId>;
  readonly evidenceRequirements: ReadonlyNonEmptyArray<EvidenceRequirement>;
  readonly jurisdictions?: ReadonlyNonEmptyArray<JurisdictionId>;
  readonly officialSources?: ReadonlyNonEmptyArray<OfficialSource>;
  readonly knownLimitations?: ReadonlyNonEmptyArray<string>;
  readonly deprecation?: RuleDeprecation;
}
```

`maturity`, `requiredCapabilities`, and `evidenceRequirements` are required for every rule accepted
by RulePack composition: built-in rules, external rules, fixtures, examples, and rules inside
excluded experimental packs. Required governance arrays are non-empty. Optional governance arrays
are also non-empty when present, so authors cannot satisfy the contract with empty placeholders.

## Capability Contract

Capability metadata is descriptive only in P13. It states which observations a rule requires, or
could use for higher precision, but it does not add capability gating, coverage accounting, journey
tracking, network observation, form state collection, confidence branching, or capability provider
registration. Those are P15 and P16 concerns.

Capability namespace identifies the observation provider or capability vocabulary owner, not the
RulePack that consumes it. A RulePack may require a capability owned by a browser host, DOM adapter,
network observer, journey recorder, host application, or third-party vocabulary. External
capabilities therefore need only use valid namespaced syntax; their namespace does not need to match
the declaring RulePack namespace.

Validation rejects duplicate capabilities and rejects overlap between `requiredCapabilities` and
`optionalCapabilities`.

### Built-in Capability Semantics

| ID | Meaning | Current examples |
| --- | --- | --- |
| `structure` | Normalized node tree facts: tag, role, parent/child relation, and control/container relation. | Button/link/container relation. |
| `text` | Direct, subtree, or normalized text available in the scanned input. | Urgency phrase, disclosure copy. |
| `attributes` | Serialized attributes normalized into the document model. This does not mean live DOM properties. | `href`, `aria-*`, static `checked`. |
| `source-location` | File, line, column, or adapter locator data. | Source edit candidates and SARIF locations. |
| `dom-state` | Live DOM property or current interactive state. | Current `checked`, `disabled`, or `open` state. |
| `style-hints` | Non-computed styling heuristics such as class names, inline style text, or semantic tokens. | `primary` or `secondary` classes. |
| `computed-style` | Browser CSSOM computed values. | Color, font size, display, visibility. |
| `viewport` | Element geometry, visibility, overlap, and position in a viewport. | Modal close visibility or overlap. |
| `interaction` | State before and after an operation within one page. | Prompt after clicking a button. |
| `journey` | Ordered sequence across multiple steps or pages. | Signup/cancel parity. |
| `form` | Field semantics, sensitivity, and submission structure. This does not prove network submission. | Payment or personal-data form. |
| `network` | Request, response, destination, redirect, or network metadata. | Cross-origin form submission. |

`attributes` is not live property state, `style-hints` is not computed style, `interaction` is not a
multi-step journey, `form` does not imply network visibility, and governance metadata never
guarantees runtime availability.

## Evidence Contract

Evidence requirements describe the evidence shape needed to justify a finding. They are not
confidence claims and do not guarantee that every runtime can observe the evidence.

| ID | Meaning |
| --- | --- |
| `presence` | A target node, text, control, or relation exists. |
| `absence` | A target was not found within an explicitly understood scan scope. It may need a known limitation when the scan scope is incomplete. |
| `text-match` | A deterministic pattern, token, dictionary, or locale-specific text match. |
| `attribute-state` | Normalized attribute or property state. |
| `comparison` | Relative comparison between two or more choices, controls, states, prices, or paths. |
| `runtime-state` | Current state observed from a live runtime rather than static input. |
| `sequence` | Ordered interaction or journey evidence. |
| `network-observation` | Request, response, redirect, destination, or network-state evidence. |

## Jurisdiction Contract

Jurisdiction metadata identifies reviewed policy context, not a legal conclusion. FairUX must never
serialize it as a compliance verdict or as proof of applicable law.

Runtime validation keeps `JurisdictionId` canonical even though TypeScript exposes it as `string`.
Allowed IDs are:

- `global`;
- exact-case `EU`;
- exact-case `EEA`;
- real uppercase ISO 3166-1 alpha-2 country codes from a frozen implementation set;
- valid namespaced external jurisdiction IDs, such as `purchase-guard/jp-commerce`.

Validation rejects lowercase country codes, `UK` as an alias for `GB`, ISO subdivisions, URLs,
URNs, free-form labels, empty strings, whitespace-only strings, control characters, bidi control
characters, and duplicate canonical IDs. The validator does not auto-normalize author input.
Subdivision support may be added later as an explicit contract change.

The ISO country-code set must be checked in as sorted immutable data in a dedicated implementation
module, with its source date or review version documented in code and docs. Validation must not
depend on host `Intl`, OS locale data, network access, or runtime updates. Special IDs `global`,
`EU`, and `EEA` live outside the country-code set. User-assigned or non-ISO codes such as `XK` are
not built-in jurisdiction IDs; authors that need them must use a namespaced external ID. Changing
the frozen set updates the validation acceptance surface and must be recorded in tests,
CHANGELOG, and the SDK beta semver policy. Removing an accepted built-in code is a breaking
contract change.

## Official Source Contract

Official sources are structured governance metadata, not legal proof. They record that a reviewer
mapped a rule to a specific publisher source on a specific date.

`OfficialSource` keeps source identity fields and review fields in one object for the beta, but
validation treats them differently:

- identity fields: `id`, `title`, `publisher`, and canonical `url`;
- review fields: `reviewedAt` and `jurisdictions`.

`OfficialSource.jurisdictions` describes the publisher/source context for that source. It is not
automatically unioned with, intersected with, or treated as a subset of `RuleMeta.jurisdictions`.
`RuleMeta.jurisdictions` describes the rule's reviewed policy context. Neither direction implies
legal applicability, compliance, or applicable-law scope.

Validation requires:

- `OfficialSource.id` is a valid namespaced ID and may use the source publisher or vocabulary owner
  namespace instead of the RulePack namespace;
- `title` and `publisher` are non-empty and have no leading or trailing whitespace;
- public strings reject C0/C1 and bidi control characters;
- `url` is a string with no leading or trailing whitespace;
- `url` parses with `new URL()` as an absolute HTTPS URL;
- the canonical URL used for snapshots and duplicate checks is `new URL(input).href`;
- WHATWG URL host case normalization and default-port normalization are accepted;
- query parameter order, fragments, and trailing slashes are not rewritten beyond `URL.href`
  serialization;
- URL username and password are forbidden;
- `reviewedAt` is a valid `YYYY-MM-DD` calendar date;
- validation is independent of the current date;
- source IDs are unique within a rule;
- canonical URLs are unique within a rule;
- within one unfiltered source RulePack, the same source ID may appear across multiple rules only
  when the identity fields match exactly after URL canonicalization;
- within one unfiltered source RulePack, `reviewedAt` and `jurisdictions` may vary per rule for the
  same source ID;
- different RulePacks do not acquire a hidden dependency merely because they use the same source ID;
- cross-pack source ID collisions are not composition conflicts in P13;
- RulePack provenance, pack version, and rule ID remain part of the source mapping identity.

The built-in source catalog should enforce identity consistency inside the built-in RulePack.

## References and Report Exposure

`references` remains the existing unstructured finding reference contract. `officialSources` is
structured rule governance metadata. P13 does not automatically project `officialSources` into
finding `references`, and it does not change the existing `ctx.createFinding()` default reference
behavior.

SARIF may expose governance metadata additively under `tool.driver.rules[].properties.fairux`, but
the JSON report keeps its existing finding shape and no top-level rule catalog is added in P13.
If a built-in migration intentionally keeps the same URL in both `references` and
`officialSources`, the catalog generator must treat that as deliberate duplication, not implicit
projection.

## Deprecation Contract

Deprecated rules carry `deprecation` metadata. Non-deprecated rules must not carry it.

`RuleDeprecation.since` and `removalTarget` are strict semver strings in the containing RulePack
version lineage. Vague release labels are not accepted in this contract. These fields do not refer
to the SDK version, the rule's own `meta.version`, or `engineApiVersion`.

`since` is the first RulePack version where the rule became deprecated. `removalTarget` is the first
RulePack version where the author intends the deprecated rule to be removed. With `packVersion`
defined as the containing RulePack version, validation requires `since <= packVersion`,
`packVersion < removalTarget` when `removalTarget` is present, and `removalTarget > since` when both
fields are present. Semver precedence comparison ignores build metadata. If a deprecated rule is
still present at or after its `removalTarget`, composition fails until the author removes the rule or
updates the target to match reality.

`reason` is non-empty and has no leading or trailing whitespace.

Replacement validation rejects self-replacement, cross-pack replacement, missing targets,
replacement chains that cycle, and replacement targets that are themselves deprecated. A replacement
must target a different rule in the same unfiltered source RulePack. External-pack references to
built-in rules and references to another external RulePack are cross-pack replacements and are not
supported until a versioned RulePack dependency contract exists. Built-in-to-built-in replacement is
allowed because both rules live in the same built-in source RulePack. Metadata validation can still
succeed when experimental filtering later excludes the replacement from execution.

Deprecation alone must not change default enablement, experimental gating, rule IDs, rule versions,
or finding fingerprints. Removing a deprecated built-in rule requires a migration note.

## Maturity and Pack Status

`RulePackMeta.status` describes the maturity of a pack contract. `RuleMeta.maturity` describes the
lifecycle of an individual rule.

- Stable packs may contain stable and opt-in experimental rules.
- Stable packs must not contain draft rules.
- Experimental packs may contain draft, experimental, and stable rules.
- Draft and experimental rules must use `experimental: true` and `defaultEnabled: false`.
- Stable rules must not use `experimental: true`.
- Deprecated rules require `deprecation` metadata and may preserve their existing runtime gate.
- Deprecated rules are not forced to be `experimental`.
- Non-deprecated rules must not carry `deprecation` metadata.

## Validation Model

RulePack composition must keep the existing strict validation model: plain own-property objects,
known keys only, no symbol keys, no inherited metadata, dense arrays only, and deterministic cloned
snapshots.

Governance validation rejects:

- unknown governance fields;
- inherited governance fields and symbol keys;
- sparse governance arrays;
- required governance arrays with zero entries;
- optional governance arrays with zero entries when present;
- non-string IDs, empty strings, duplicate IDs, or duplicate canonical IDs;
- C0/C1 control characters or bidirectional control characters in public strings;
- leading or trailing whitespace in URL inputs, official-source titles, official-source
  publishers, deprecation reasons, or known limitation items;
- capability IDs that are neither built-in IDs nor valid namespaced IDs;
- duplicate required capabilities, duplicate optional capabilities, and required/optional overlap;
- duplicate evidence requirements, jurisdictions, source IDs within one rule, canonical source URLs
  within one rule, and exact duplicate known limitation items;
- jurisdiction IDs outside the canonical grammar in this ADR;
- official source URLs that are not parseable absolute HTTPS URLs after `new URL(input)` or that
  contain credentials;
- official source `reviewedAt` values that are not valid calendar dates;
- official source identity conflicts within one unfiltered source RulePack;
- deprecated rules without `deprecation`;
- non-deprecated rules with `deprecation`;
- non-semver `since` or `removalTarget` deprecation values, `since > packVersion`,
  `removalTarget <= packVersion`, or `removalTarget <= since`;
- invalid replacement rule scope, missing targets, self-replacement, replacement cycles, or
  deprecated replacement targets.

Governance validation runs before pack-status exclusion. Every input RulePack is strictly validated
and cloned for pack shape, taxonomy, rules, governance metadata, and same-pack deprecation targets
before `includeExperimental` or pack status decides whether the pack participates in the composed
runtime ruleset. An invalid experimental pack is rejected even when `includeExperimental: false`.
Cross-pack checks, where P13 still has any, apply only to included packs. Rule-level experimental
gating is scanner policy and does not skip RulePack metadata validation.

## Public Exposure

Governance types are implemented in the private `@fairux/core` package and mirrored through the
public `@fairux/sdk` compatibility contract. The canonical public import for governance authoring
types is the SDK root:

```ts
import type {
  CapabilityId,
  EvidenceRequirement,
  OfficialSource,
  RuleDeprecation,
  RuleMaturity,
  RulePack,
} from "@fairux/sdk";
```

External consumers must not import governance authoring types from internal FairUX packages or
source files. `@fairux/sdk/html` and `@fairux/sdk/dom` expose scanner-specific APIs and public types;
they are not required to re-export every RulePack authoring type.

The SDK public type mirror must stay in parity with the private core implementation. Packed
TypeScript consumers must be able to author custom RulePacks with these fields without importing
private packages.

## Built-in Rule Review

Built-in rules must migrate onto this contract before P13 closes. A rule can become `stable` only
after review records cover positive, negative, ambiguous, locale, runtime-specific, and
false-positive cases appropriate to that rule. Official-source mapping must be made per rule from
reviewed primary sources, not by assigning one broad URL to every rule.

Source URLs and source relevance must be checked when the built-in migration PR is prepared. Review
records may store short summaries and identifiers, but they must not copy long source text.

## Consequences

The SDK beta will expose a richer authoring contract without claiming broader detection coverage.
External products can describe their own capability and jurisdiction context with namespaced IDs,
while FairUX preserves deterministic local scanning and avoids legal, fraud, and safety verdicts.

The tradeoff is stricter authoring. RulePack authors must provide lifecycle and evidence metadata
for each rule, and invalid governance data fails composition before a scanner can run.

This is a source-breaking RulePack authoring migration, not a purely additive change, because
`maturity`, `requiredCapabilities`, and `evidenceRequirements` become required fields. It is
acceptable only because the public SDK beta has not been published yet. Existing fixtures, examples,
and built-in rules must migrate in the same PR wave before release. After SDK publication, adding
required RuleMeta fields must follow the package semver policy. `engineApiVersion` is not increased
for this ADR because P13-T8 and P13-T9 change only the planned beta contract, not the currently
implemented runtime contract.

## Non-goals

- Runtime capability gating.
- Coverage-aware risk scoring.
- Network observation or linked-page following.
- Legal compliance, fraud, or site-safety verdicts.
- Remote RulePack loading or sandboxing untrusted rule code.
- Changing existing built-in rule IDs, rule versions, or finding fingerprints.
- TypeScript implementation, semver comparator implementation, jurisdiction code-set
  implementation, SARIF implementation, built-in rule migration, npm publication, or SDK release
  tag creation in P13-T8/P13-T9.
