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

Reviewers should record the source ID, URL, publisher, title, jurisdiction context, and review date.
The same source ID may be reused across rules only when the normalized source metadata is identical.
Reviewers should not copy long passages into the repository.

## False-positive review

A rule's false-positive review should state the common benign patterns it intentionally ignores or
cannot distinguish. If a rule needs computed style, interaction state, linked pages, form history,
or network observation that FairUX does not yet collect, that limitation belongs in metadata.

Optional capabilities should be used when a rule can run with current observations but can become
more precise when a future provider supplies additional observations. Do not mark a capability as
required merely to document a possible future improvement.

## Stable promotion

A built-in rule can be marked `stable` only when its metadata, fixtures, source mapping, limitation
notes, and deterministic tests match the contract in
[`ADR P13-T1`](../design/decisions/P13-T1-rule-governance-contract.md).

Before SDK publication, the governance migration is allowed to be source-breaking for RulePack
authors because the beta has not shipped. After publication, adding required metadata fields must
follow the package semver policy and include migration notes.
