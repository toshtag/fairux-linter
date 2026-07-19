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
understand a rule's maturity, required observation capabilities, evidence expectations,
jurisdictional review context, source review state, limitations, and deprecation lifecycle before
the SDK beta is published.

These fields are governance metadata. They do not prove that a page is legal, illegal, fair, unsafe,
or fraudulent. They also do not mean FairUX has implemented runtime coverage for every capability
named by a rule.

## Decision

Additive governance metadata will be added to `RuleMeta` before the SDK beta becomes the stable
public authoring contract:

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

export type JurisdictionId = string;

export interface OfficialSource {
  readonly id: string;
  readonly title: string;
  readonly publisher: string;
  readonly url: string;
  readonly jurisdictions?: readonly JurisdictionId[];
  readonly reviewedAt: string;
}

export interface RuleDeprecation {
  readonly since: string;
  readonly reason: string;
  readonly replacementRuleId?: string;
  readonly removalTarget?: string;
}
```

`RuleMeta` will gain these fields:

```ts
export interface RuleMeta {
  readonly maturity: RuleMaturity;
  readonly requiredCapabilities: readonly CapabilityId[];
  readonly evidenceRequirements: readonly EvidenceRequirement[];
  readonly jurisdictions?: readonly JurisdictionId[];
  readonly officialSources?: readonly OfficialSource[];
  readonly knownLimitations?: readonly string[];
  readonly deprecation?: RuleDeprecation;
}
```

`maturity`, `requiredCapabilities`, and `evidenceRequirements` are required for built-in rules and
RulePack fixtures. `jurisdictions`, `officialSources`, `knownLimitations`, and `deprecation` are
optional unless another rule below makes them mandatory.

The existing `experimental?: boolean` field remains the runtime opt-in gate for this beta. The new
`maturity` field describes the rule lifecycle:

- `draft`: development metadata, not for public stable packs.
- `experimental`: public but not yet stable; false-positive profile or evidence review is still
  incomplete.
- `stable`: reviewed for the current capability and evidence contract.
- `deprecated`: retained for compatibility but not recommended for new use.

Rules with `maturity: "draft"` or `"experimental"` must use `experimental: true` and
`defaultEnabled: false`. `maturity: "stable"` must not use `experimental: true`.
`maturity: "deprecated"` requires `deprecation` metadata. Non-deprecated rules must not carry
`deprecation`.

Capability metadata is descriptive only in P13. It states what observations the rule expects, but it
does not add capability gating, coverage accounting, journey tracking, network observation, or form
state collection. Those are P15 and P16 concerns.

Evidence requirements describe the evidence shape needed to justify a finding. They do not guarantee
that every runtime can observe that evidence.

Jurisdiction metadata identifies reviewed policy context, not a legal conclusion. FairUX must never
serialize it as a compliance verdict.

Official sources are reviewed references. They must be specific primary or official publisher
sources whenever possible, use HTTPS URLs, and include a review date. An official source proves only
that a reviewer mapped a rule to that source on that date. It is not proof of legality,
non-compliance, fraud, safety, or unfairness.

Known limitations are first-class public metadata. They should state concrete observation limits,
such as static HTML not seeing computed style, scanners not following linked policy pages, or DOM
scans only seeing the current document state.

## Validation

RulePack composition must keep the existing strict validation model: plain own-property objects,
known keys only, no symbol keys, no inherited metadata, dense arrays only, and deterministic cloned
snapshots.

Governance validation rejects:

- unknown governance fields;
- inherited governance fields and symbol keys;
- sparse governance arrays;
- non-string IDs, duplicate IDs, or empty strings;
- C0/C1 control characters or bidirectional control characters in public strings;
- capability IDs that are neither built-in IDs nor valid namespaced IDs;
- duplicate capabilities, evidence requirements, jurisdictions, and source IDs;
- external capability IDs whose namespace does not match the declaring pack namespace;
- jurisdiction IDs that are empty, whitespace-only, URLs, control-character-bearing, or duplicated
  case-insensitively;
- official source URLs that are not HTTPS;
- official source `reviewedAt` values that are not valid `YYYY-MM-DD` calendar dates;
- deprecated rules without `deprecation`;
- non-deprecated rules with `deprecation`;
- deprecation replacements that point to the same rule ID.

`RuleDeprecation.since` must be semver or an explicit release label. `removalTarget` must be semver
or an explicit release label. Removing a deprecated built-in rule requires a migration note.
Deprecating a rule must not change existing finding fingerprints by default.

## Public Exposure

The governance types are public through `@fairux/core` and `@fairux/sdk`. The SDK public type mirror
must stay in parity with the core contract. Packed TypeScript consumers must be able to author
custom RulePacks with these fields without importing private packages or source files.

FairUX will not add a top-level rule metadata catalog to `FairUxReport` in this task. JSON findings
keep their existing `references` shape. SARIF may expose governance metadata additively under
`tool.driver.rules[].properties.fairux` so SARIF consumers can inspect rule maturity and evidence
context without changing finding fingerprints or the JSON report schema version.

`fairux rules`, `fairux explain`, coverage-aware risk summaries, and capability-based skip reports
remain future work.

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

## Non-goals

- Runtime capability gating.
- Coverage-aware risk scoring.
- Network observation or linked-page following.
- Legal compliance, fraud, or site-safety verdicts.
- Remote RulePack loading or sandboxing untrusted rule code.
- Changing existing built-in rule IDs, rule versions, or finding fingerprints.
