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
`approvedBy` or `approvedAt`; take them from the human approval event itself — the approver's exact
account name, and the event's UTC date. `pnpm rules:reviews:check:approved` fails while any stable
built-in rule remains only `prepared`, so a rule cannot reach a release as an unapproved stable
rule.

### Approval evidence

An approval happens in a pull request comment, which CI cannot read. The repository records what it
can verify against itself in `packages/rules/reviews/maintainer-approval.json`: the approval target
commit, the substantive review fingerprint from `pnpm rules:reviews:approval:fingerprint`, the
comment URL, the approver and approval date, and the exact stable and experimental rule ids the
decision covers.

`pnpm rules:reviews:check:approved` validates that evidence against the packet on every CI run. It
requires the approver and approval target to be the expected ones, the fingerprint to still match
the current review content, the **detection digest** to still match what the built rules do, the rule
id lists to still match the current maturity partitions, every stable record to carry the approval,
and every experimental record to remain prepared and default-off.

### The detection digest, and the hole it closes

The fingerprint hashes the review **records**: prose, sources, evidence, and the `ruleVersion` each
record declares. It does not hash the rules. So an author who edited a matching pattern and left the
version alone passed everything — the record still matched the declared version, the fingerprint was
unchanged, and a maintainer approval covering different behaviour kept validating.

That was measured, not suspected. Widening one dictionary pattern without touching a version passed
`rules:reviews:check`, `rules:reviews:check:approved`, `rules:catalog:check`, `eval:corpus:check`,
and the whole test suite, with a stable rule detecting something nobody approved.

`detectionDigest` in `maintainer-approval.json` is a SHA-256 over what the **built** package matches
with:

- every dictionary pattern, by locale and group, as `source` and `flags`;
- every rule's execution metadata — severity, confidence, enablement, maturity, page-context scoping,
  and required and optional capabilities;
- every **page-context keyword**, which is what a rule's `appliesTo` resolves against.

The last one was the same hole one level down. Scoping was hashed from the first version and the
table it points at was not, so a scoped rule could be silenced everywhere — or made to fire
everywhere — without moving the digest. A rule that stops running reports nothing, which reads
exactly like a page with nothing wrong.

Computed from the build rather than the source, so a comment, a rename, or a reformat cannot
invalidate an approval and a pattern that reaches the runtime always does. Patterns are sorted before
hashing, because the order a set is tried in does not change what the set matches.

**An absent digest is a refusal, not a pass.** A caller that cannot compute one cannot confirm the
approval covers what the rules do.

**What it still does not cover:** a rule's `evaluate` body. `obstruction/confirmshaming` requires an
interactive control as well as a dictionary match, and changing that requirement changes detection
without moving the digest. Hashing function source would catch it and would also invalidate an
approval on a comment edit, which is a worse trade. The gap is narrower than the one this closed, and
it is written down here rather than left for someone to find — a check described as fail-closed and
quietly not is how this started.

That check is offline by design: it never contacts GitHub, so it cannot prove the approval comment
exists. Retrieving the comment and verifying its author, date, and body against the packet happens
once, when the approval is applied, and the result is recorded in the phase's review packet under
`docs/reviews/`.

Because the evidence pins the exact rule id lists, adding a stable built-in rule without carrying it
through review and approval fails CI rather than shipping as `prepared`.

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
notes, and deterministic tests match the governance contract enforced by RulePack validation and
`pnpm rules:reviews:check`.

Before SDK publication, the governance migration is allowed to be source-breaking for RulePack
authors because the beta has not shipped. After publication, adding required metadata fields must
follow the package semver policy and include migration notes.

Deprecated rules may remain in stable or experimental packs when they carry valid `deprecation`
metadata. Deprecation alone should not change runtime gating: a previously experimental rule may
remain opt-in, and a previously non-experimental rule may preserve its existing default enablement.
