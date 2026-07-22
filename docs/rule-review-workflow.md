# Rule review workflow

Rule review is the process for moving a rule from draft or experimental metadata to stable metadata.
It is separate from runtime execution.

## Review record

Built-in rule reviews are stored as machine-readable prepared records in
`packages/rules/reviews/built-in-rule-reviews.json`. Official source identities are stored
separately in `packages/rules/reviews/official-sources.json`; source records do not contain
rule-specific review notes, approval fields, or rule lists.

Run `pnpm rules:reviews:check` after editing either file. The check verifies that every built-in
rule has exactly one review record, that each review record matches the built runtime rule ID,
version, maturity, and default enablement, that source IDs resolve to the identity catalog, that
prepared records do not contain maintainer approval fields, and that executable positive and
negative corpus evidence is recorded for every rule. Jurisdiction IDs and SemVer strings are
validated through the same `@fairux/core` contracts used by RulePack runtime validation; use `GB`
for the United Kingdom, not a `UK` alias.

The source catalog uses schema v2. Source identity is limited to `id`, `title`, `publisher`, and
`url`. Publication metadata such as source type, publication status, `statusCheckedAt`, and source
summary belongs in catalog metadata. Source-level jurisdictions are intentionally excluded because
jurisdiction review is rule-specific.
Non-current source statuses (`historical`, `proposed`, and `vacated`) require `statusNote`.
Historical or vacated sources may only be mapped with `supportKind: "historical"`, proposed sources
may only be mapped with `supportKind: "proposed"`, and current sources must not be mapped as
historical or proposed. `sourceType: "standard"` and `supportKind: "standard"` are paired: a
standard source requires standard support, and standard support is allowed only for standard
sources.

The built-in review record uses schema v2. Each record includes `ruleVersion`, `preparedBy`,
`preparedAt`, `ruleJurisdictions`, rule-specific `officialSourceReviews`, executable
`corpusEvidence`, `uncoveredScenarios`, review notes, and `reviewExceptions`. Each official source
mapping records `reviewedAt`, rule-specific jurisdictions, `supportKind`, `sourceLocator`, why the
source supports that rule review, and what the source does not establish. Mapping notes must be
source-specific within a rule and must not be a template phrase. `sourceLocator` must identify a
specific section, heading, article, paragraph, page, FAQ, or standard subsection rather than only a
broad source family.

Each stable built-in rule should have review evidence covering:

- positive fixtures where the rule should fire;
- negative fixtures where similar UI should not fire;
- ambiguous fixtures that document expected limits when they are backed by executable tests;
- uncovered scenarios for review-only examples that are not yet corpus evidence;
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

## Review status

`prepared` means the record is ready for maintainer review. It is not approval. Merging a PR, a
passing CI run, or an agent-written note is not enough to mark a rule as approved.

Only explicit maintainer review may change a record to `maintainer-approved`. Do not infer
`approvedBy` or `approvedAt`; add those fields only from the human approval event. P13 closeout must
run `pnpm rules:reviews:check --require-approved-stable`, which fails while stable built-in rules
remain only `prepared`.

`reviewExceptions` are reserved for explicit review gaps. Open exceptions carry `id`, `scope`,
`status`, `owner`, `reason`, and `resolutionCriteria` only. `approvedBy` and `approvedAt` are
allowed only when an exception is explicitly changed to `maintainer-approved`.

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
the rule-specific review fields (`reviewedAt`, `jurisdictions`, `mappingNote`, and `limitations`).
Within one RulePack, the same source ID may be reused across rules only when the identity fields
match exactly after URL canonicalization. The review fields may differ per rule. Source ID reuse
across different RulePacks is not a composition conflict.
Reviewers should not copy long passages into the repository.

Source publication status must be checked from primary or official publisher sources. Historical or
vacated rulemaking records can support agency rationale review, but they must not be represented as
current regulation. The FTC 2024 Negative Option final rule amendments are cataloged as `vacated`
and historical only; current negative-option mappings use the current rule text and 2026 ANPRM
separately. Current 16 CFR Part 425 is limited to prenotification negative option plans, so built-in
subscription and cancellation review records may use it only as contextual support unless the rule
signal is narrowed to that current regulatory scope.
EDPB consent guidance applies to EU and EEA consent review records. It can contextualize genuine or
free choice signals, but direct visual-prominence support should come from sources that address
equal prominence, styling, or concrete interface treatment.

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
