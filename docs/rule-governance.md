# Rule governance

Rule governance metadata describes how a rule should be reviewed, interpreted, and maintained. It
does not change FairUX from a deterministic UX-risk scanner into a legal, fraud, or site-safety
system.

The contract is defined in
[`ADR P13-T1`](../design/decisions/P13-T1-rule-governance-contract.md).

## Maturity

Rules use four maturity states:

- `draft`: under development; not suitable for public stable packs.
- `experimental`: public but opt-in; evidence review or false-positive profile is incomplete.
- `stable`: reviewed against the current evidence and capability contract.
- `deprecated`: retained for compatibility but no longer recommended.

For this beta, `experimental?: boolean` remains the runtime opt-in gate. A rule with
`maturity: "draft"` or `maturity: "experimental"` must be `experimental: true` and
`defaultEnabled: false`. A stable rule must not be execution-experimental.

`RulePackMeta.status` describes the pack contract. `RuleMeta.maturity` describes one rule. Stable
packs may include opt-in experimental rules, but they must not include draft rules.

The required governance fields apply to every rule accepted by RulePack composition: built-in
rules, external rules, fixtures, examples, and rules inside experimental packs that are later
excluded from runtime composition.

## Capabilities

`requiredCapabilities` names the observations a rule needs to run correctly. `optionalCapabilities`
names observations that can improve precision when a future runtime provides them.

This is metadata only until later capability and coverage work. Adding a capability ID does not mean
the current scanner can observe it, skip by it, or report coverage for it.

Capability namespace identifies the observation provider or capability vocabulary owner, not the
RulePack that consumes it. External capabilities must be namespaced, for example
`browser/computed-style` or `purchase-flow/journey`, but they do not need to match the declaring
RulePack namespace.

Required and optional capability arrays must be non-empty when present, must not contain duplicates,
and must not overlap.

| ID | Meaning |
| --- | --- |
| `structure` | Normalized node tree facts such as tag, role, and parent/child relation. |
| `text` | Direct, subtree, or normalized text available in the scanned input. |
| `attributes` | Serialized attributes normalized into the document model; not live DOM properties. |
| `source-location` | File, line, column, or adapter locator data. |
| `dom-state` | Live DOM property or current interactive state. |
| `style-hints` | Non-computed styling heuristics such as classes or inline style text. |
| `computed-style` | Browser CSSOM computed values. |
| `viewport` | Element geometry, visibility, overlap, and position in a viewport. |
| `interaction` | State before and after an operation within one page. |
| `journey` | Ordered sequence across multiple steps or pages. |
| `form` | Field semantics, sensitivity, and submission structure; not network submission proof. |
| `network` | Request, response, destination, redirect, or network metadata. |

## Evidence

`evidenceRequirements` states the evidence shape needed for a finding, such as `presence`,
`absence`, `text-match`, `attribute-state`, `comparison`, `runtime-state`, `sequence`, or
`network-observation`.

Evidence requirements are not confidence claims. A rule still needs tests and review notes showing
that its evidence is useful and deterministic.

| ID | Meaning |
| --- | --- |
| `presence` | A target node, text, control, or relation exists. |
| `absence` | A target was not found within an explicitly understood scan scope. |
| `text-match` | A deterministic pattern, token, dictionary, or locale-specific text match. |
| `attribute-state` | Normalized attribute or property state. |
| `comparison` | Relative comparison between two or more choices, controls, states, prices, or paths. |
| `runtime-state` | Current state observed from a live runtime rather than static input. |
| `sequence` | Ordered interaction or journey evidence. |
| `network-observation` | Request, response, redirect, destination, or network-state evidence. |

## Jurisdictions and official sources

`jurisdictions` identify reviewed policy context. They do not assert that a page is legal,
illegal, compliant, or non-compliant.

`officialSources` record specific reviewed publisher material. Source URLs must use HTTPS and
`reviewedAt` must be a valid calendar date. Source metadata should point to primary or official
publisher pages when possible and should store concise summaries, not copied source text.

An official source mapping is evidence of review scope. It is not proof that a finding is legally
correct.

Jurisdiction IDs are canonical. Valid built-in IDs are `global`, `EU`, `EEA`, and uppercase ISO
3166-1 alpha-2 country codes from the implementation's frozen set. External jurisdiction IDs use
namespaced syntax. Lowercase country codes, aliases such as `UK`, ISO subdivisions, URLs, and
free-form labels are rejected.

The ISO country-code set is checked-in, sorted, immutable data. Validation does not depend on host
`Intl`, OS locale data, network access, or runtime updates. Non-ISO user-assigned codes such as
`XK` are not built-in jurisdictions; use a namespaced external ID when a product needs one.

Official source IDs are namespaced IDs. Source identity fields are `id`, `title`, `publisher`, and
canonical URL. Review fields are `reviewedAt` and `jurisdictions`. The same source ID may be shared
inside one RulePack only when the identity fields match; review fields may differ per rule.
Different RulePacks may use the same source ID without creating a composition conflict.

Source URLs must be parseable absolute HTTPS URLs without credentials. Their canonical form is
`new URL(input).href`; query order, fragments, and trailing slash are not rewritten outside WHATWG
URL serialization. `officialSources` are not automatically copied into finding `references`;
references remain the existing unstructured finding reference field.

Rule jurisdictions and official-source jurisdictions are not automatically unioned, intersected, or
validated as subsets. FairUX does not infer legal applicability from either field.

## Deprecation

Deprecated rules carry `deprecation` metadata with `since`, `reason`, and optionally a replacement
rule ID or removal target. Deprecation should preserve existing finding fingerprints unless a
separate migration decision justifies the change.

Removal requires a migration note.

`since` and `removalTarget` use strict semver in the containing RulePack version lineage, not the
SDK version, rule version, or `engineApiVersion`. Validation requires `since <= pack.meta.version`;
when `removalTarget` is present, it must be greater than both the current pack version and `since`.

Replacement rules must be different rules in the same unfiltered source RulePack. External packs
cannot point at built-in rules or other external packs until FairUX has a versioned RulePack
dependency contract. Validation rejects self-replacement, cross-pack replacement, missing targets,
replacement cycles, and deprecated replacement targets.

## Limitations

`knownLimitations` should be explicit and observable. Good limitations say what the scanner cannot
see, such as computed visual prominence in static HTML, linked policy pages, cross-document flows,
or dynamic text that is not present in the scanned input.

Known limitation items must not have leading or trailing whitespace, must not contain C0/C1 or bidi
controls, and must not be exact duplicates.
