# Rule governance

Rule governance metadata describes how a rule should be reviewed, interpreted, and maintained. It
does not change FairUX from a deterministic UX-risk scanner into a legal, fraud, or site-safety
system.

The contract is defined by the public `RuleMeta` types in `@fairux/sdk`, the RulePack composition
validator, and the catalog and review checks in CI.

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
packs may include opt-in experimental and deprecated rules, but they must not include draft rules.
Experimental packs may include draft, experimental, stable, and deprecated rules.

| RulePack status | `draft` | `experimental` | `stable` | `deprecated` |
| --- | --- | --- | --- | --- |
| `stable` | reject | allow | allow | allow |
| `experimental` | allow | allow | allow | allow |

Draft and experimental rules must use `experimental: true` and `defaultEnabled: false`. Stable
rules must not use `experimental: true`. Deprecated rules require `deprecation` metadata and may
preserve their previous runtime gate. A deprecated experimental rule may stay opt-in; a deprecated
non-experimental rule may keep its existing default enablement.

The required governance fields apply to every rule accepted by RulePack composition: built-in
rules, external rules, fixtures, examples, and rules inside experimental packs that are later
excluded from runtime composition.

## Capabilities

`requiredCapabilities` names the observations a rule needs to run correctly. `optionalCapabilities`
names observations that improve precision where a runtime provides them.

**These fields decide whether a rule runs.** A scan resolves what its input can supply — the runtime
baseline in `RUNTIME_CAPABILITIES`, or whatever the document declares for itself — and a rule whose
required capabilities are not all available is skipped and reported as skipped, with the missing IDs.
Declaring a capability a rule does not use will silence it on inputs that cannot supply it;
declaring too few will let it run where its evidence does not exist.

Optional capabilities never gate. A rule missing one runs with less than the evidence it can use, and
the report records it as a weaker pass rather than a clean one.

What is *not* claimed by any of this: an executed rule is not a correct rule, an available capability
is not proof the evidence was good, and coverage is not a score. See
[the report schema](fairux-report-schema.md#coverage).

Capability IDs name observation contracts, not runtime provider instances. Multiple providers may
advertise the same capability ID, and provider registration and provenance are separate P15
contracts.

Use built-in IDs for built-in observation semantics regardless of provider. Browser-computed CSS
uses `computed-style`, multi-step flows use `journey`, and network observations use `network`;
do not create namespaced provider aliases for built-in capability meanings.

Namespaced external capabilities are only for new observation contracts that are not in the
built-in vocabulary, such as `browser/paint-order`,
`design-system/semantic-prominence`, `host/consent-state`, or
`purchase-flow/checkout-stage-history`. The namespace identifies the external capability vocabulary
owner, not the RulePack that consumes it and not the runtime provider instance.

Required and optional capability arrays must be non-empty when present, must not contain duplicates,
and must not overlap. Composition rejects namespaced capability IDs whose terminal segment is a
built-in capability name, such as provider aliases for built-in CSS, journey, or network semantics.

| ID | Meaning |
| --- | --- |
| `structure` | Normalized node tree facts such as tag, role, and parent/child relation. |
| `text` | Direct, subtree, or normalized text available in the scanned input. |
| `attributes` | Serialized attributes normalized into the document model; not live DOM properties. |
| `source-location` | File, line, column, or adapter locator data. |
| `source-range` | End-bounded ranges, and the source text behind them, for a node's attributes. |
| `dom-state` | Live DOM property or current interactive state. |
| `style-hints` | Non-computed styling heuristics such as classes or inline style text. |
| `computed-style` | Browser CSSOM computed values. |
| `viewport` | Element geometry, visibility, overlap, and position in a viewport. |
| `interaction` | State before and after an operation within one page. |
| `journey` | Ordered sequence across multiple steps or pages. |
| `form` | Field semantics, sensitivity, and submission structure; not network submission proof. |
| `network` | Request, response, destination, redirect, or network metadata. |

What each input supplies today. An adapter checks its own row against a document it parsed, so this
is measured rather than asserted:

| Runtime | Supplies |
| --- | --- |
| `html` | `structure`, `text`, `attributes`, `source-location`, `style-hints` |
| `html`, with `sourceRanges` | the above, plus `source-range` |
| `dom` | `structure`, `text`, `attributes`, `dom-state`, `style-hints` |
| `dom`, with `visualFacts` | the above, plus `computed-style` and `viewport` |
| `dom`, with `formFacts` | the above, plus `form` |
| `ast` | `structure`, `text`, `attributes`, `source-location`, `style-hints` |
| `figma` | `structure`, `text`, `attributes` |

`computed-style` and `viewport` come only from a live rendering engine, and only when asked for:
`parseDocument(doc, { visualFacts: true })`, `scanDom(doc, { visualFacts: true })`, or the Chrome
extension, which has them on. Reading them forces layout for every element, so a caller that does not
need them does not pay for it — and a document that did not read them does not claim them, which is
what keeps a rule from running blind against absent values.

The properties collected are a fixed list — `display`, `visibility`, `opacity`, `color`,
`background-color`, `font-size`, `font-weight` — exported as `COLLECTED_STYLE_PROPERTIES`. A full
CSSOM snapshot per element differs between engines and would make two reports incomparable. Geometry
is recorded in whole CSS pixels for the same reason.

`form` comes from constraint validation, which only a live form has: `willValidate`, the constraints
a control currently fails, and the form that owns it. A control barred from validation records no
failed constraints even where the engine computes them — it is not failing anything *in effect*, and
the authored `required` remains in `attributes` for the other question. Requested separately from
`visualFacts`; asking for one does not claim the other.

`journey` is supplied by a journey scan and nothing else: it means the input is an ordered flow of
more than one step. A rule that needs it goes in a RulePack's `journeyRules`, must declare `journey`
in `requiredCapabilities`, and reads the whole flow rather than one document — see
[the report schema](fairux-report-schema.md#journey-report-shape-journeyreport). A single-document
scan always reports `journey` as unavailable, and the capabilities offered to a journey rule are the
intersection of the steps' plus `journey` itself.

`source-range` is what a rule needs to propose a *precise* edit. `source-location` says where an
element starts; a remediation that removes ` checked` needs where that attribute is, and until this
existed no built-in rule could derive one — `@fairux/core` and `@fairux/rules` are browser-safe, so
they cannot read the file the way an external RulePack can. A range covers the attribute *and the
whitespace before it*, because that is the removal that leaves valid markup, and it carries the
source text, because a rule with no filesystem must still fill `TextEdit.expected`.
`removeAttributeEdit(node, name)` builds the edit and returns `undefined` rather than guessing.

It costs memory per attribute for as long as the document is held — about 1.7× the serialized model
on an attribute-heavy page — so it is requested rather than assumed: `parseHtml(html, { sourceRanges:
true })` or `scanHtml(html, { sourceRanges: true })`. The CLI turns it on for **every** scan rather
than only for `--fix-dry-run` and `--fix-write`: capabilities decide which rules run, and a fix flag
that changed the findings would be a fix flag that changed the exit code.

The other three adapters supply nothing here, for three different reasons. **Live DOM** and **Figma**
have no source text to point at — a DOM node's attribute has no file, line, or byte. **JSX/TSX** does,
and TypeScript's AST knows where each attribute sits, but the question there is not the same one: an
attribute value may be an expression, so deleting ` checked={isDefault}` removes a binding rather
than an attribute, and classifying that as a `safe` edit to source code needs an argument this has
not made. It is deliberately open rather than unnoticed.

Nothing supplies `interaction` or `network`, so every scan reports them as unavailable and every rule
requiring one is skipped. The two are unsupplied for different reasons: `interaction` has not been
built, and `network` **will not be** under the current design — the extension permission it would
need, what could be recorded, where an observation could live, and where it sits relative to the
Purchase Guard line are all decided in
[the security boundary](security-boundary.md#the-network-capability-and-why-it-stays-unavailable). A
rule declaring `network` is still valid metadata and will still be skipped. A document from an adapter outside this
repository states its own set on `UiDocument.capabilities`, which is taken over the baseline; an empty
array is a claim that the document backs nothing, not a missing value.

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

SARIF exposes governance metadata additively under `tool.driver.rules[].properties.fairux`.

Rule jurisdictions and official-source jurisdictions are not automatically unioned, intersected, or
validated as subsets. FairUX does not infer legal applicability from either field.

## Deprecation

Deprecated rules carry `deprecation` metadata with `since`, `reason`, and optionally a replacement
rule ID or removal target. Deprecation should preserve existing finding fingerprints unless a
separate migration decision justifies the change. `maturity: "deprecated"` alone must not change
experimental gating or default enablement.

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
