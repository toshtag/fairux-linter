# Rule review workflow

Rule review is the process for moving a rule from draft or experimental metadata to stable metadata.
It is separate from runtime execution.

## Review record

Each stable built-in rule should have review evidence covering:

- positive fixtures where the rule should fire;
- negative fixtures where similar UI should not fire;
- ambiguous fixtures that document expected limits;
- English and Japanese applicability notes when text matching is involved;
- runtime notes for HTML, DOM, AST, or future adapters;
- false-positive notes;
- evidence usefulness review;
- official-source review;
- required and optional capability review;
- jurisdiction and official-source ID validation review;
- known limitations;
- performance impact;
- deterministic repeatability;
- reviewer and reviewed date.

The review date records when the source and fixtures were checked. It does not claim that external
law, platform policy, or guidance remained unchanged after that date.

## Corpus classes

Rule fixtures should be classified where possible:

- `positive`
- `negative`
- `ambiguous`
- `regression`
- `hostile-large`
- `locale`
- `runtime-specific`
- `external-consumer`

The first migration does not need to rebuild every corpus. It must make the classification and
promotion criteria explicit so future rules cannot become stable by only adding metadata.

## Official-source review

Use primary or official publisher sources when possible. A source must support the UX pattern being
mapped. Do not assign one broad generic page to every rule just to satisfy metadata.

Reviewers should record the source identity fields (`id`, URL, publisher, and title) separately from
the rule-specific review fields (`reviewedAt` and `jurisdictions`). Within one RulePack, the same
source ID may be reused across rules only when the identity fields match exactly after URL
canonicalization. The review fields may differ per rule. Source ID reuse across different RulePacks
is not a composition conflict.
Reviewers should not copy long passages into the repository.

## False-positive review

A rule's false-positive review should state the common benign patterns it intentionally ignores or
cannot distinguish. If a rule needs computed style, interaction state, linked pages, form history,
or network observation that FairUX does not yet collect, that limitation belongs in metadata.

Optional capabilities should be used when a rule can run with current observations but can become
more precise when a future provider supplies additional observations. Do not mark a capability as
required merely to document a possible future improvement.

Capability review should confirm that rules name observation contracts, not provider instances.
Built-in semantics use built-in IDs such as `computed-style`, `journey`, and `network` regardless
of provider. Namespaced external capabilities are reserved for new observation contracts that are
not already in the built-in vocabulary.

## Stable promotion

A built-in rule can be marked `stable` only when its metadata, fixtures, source mapping, limitation
notes, and deterministic tests match the contract in
[`ADR P13-T1`](../design/decisions/P13-T1-rule-governance-contract.md).

Before SDK publication, the governance migration is allowed to be source-breaking for RulePack
authors because the beta has not shipped. After publication, adding required metadata fields must
follow the package semver policy and include migration notes.

Deprecated rules may remain in stable or experimental packs when they carry valid `deprecation`
metadata. Deprecation alone should not change runtime gating: a previously experimental rule may
remain opt-in, and a previously non-experimental rule may preserve its existing default enablement.
