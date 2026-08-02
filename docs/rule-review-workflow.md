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

## How a rule change lands

A rule change is an ordinary code change. It has no publish, no deployment, no secret, and no
destructive external effect, so it needs no protected environment and no human approval event — it
needs a pull request, a review of the diff, and green checks.

What CI requires is that the change was made **deliberately**:

1. If what a rule matches changed, its `ruleVersion` moved.
2. The review record says what it now detects and why.
3. `rule-review-baseline.json` agrees with the built rules.
4. Positive, negative, and mutation tests pass.
5. The corpus evaluation and the generated catalog are current.

Steps 3 and 5 are regenerated, never typed:

```bash
pnpm rules:reviews:update
```

Include the regenerated baseline alongside the version bump and the review record. If the baseline is
stale, CI says exactly that and names the command; it does not send anybody to open Actions or find a
maintainer.

`reviewPolicy.status` stays `prepared`, and it means what it says: a record is an AI-prepared or
author-prepared review of the evidence, not a legal determination and not an endorsement. It is read
as provenance for the rule, not as a sign-off on it.

### The review baseline

`packages/rules/reviews/rule-review-baseline.json` holds four values and nothing else:

| Field | What it pins |
| --- | --- |
| `reviewContentSha256` | The review records — prose, sources, evidence, declared versions. |
| `detectionDigest` | What the built rules actually match on. |
| `rules[]` | Each stable rule's id and shipped version. |
| `schemaVersion` | The shape of this file. |

There is deliberately no `approvedBy`, `approvedAt`, `approvalTargetCommit`, `environment`, or
`workflowRunUrl`. None of them say whether a rule is correct.

### The detection digest, and the hole it closes

The fingerprint hashes the review **records**: prose, sources, evidence, and the `ruleVersion` each
record declares. It does not hash the rules. So an author who edited a matching pattern and left the
version alone passed everything — the record still matched the declared version and the fingerprint
was unchanged.

That was measured, not suspected. Widening one dictionary pattern without touching a version passed
`rules:reviews:check`, `rules:catalog:check`, `eval:corpus:check`, and the whole test suite, with a
stable rule detecting something nobody had reviewed.

`detectionDigest` is a SHA-256 over what the **built** package matches with:

- every dictionary pattern, by locale and group, as `source` and `flags`;
- every rule's execution metadata — severity, confidence, enablement, maturity, page-context scoping,
  and required and optional capabilities;
- every **page-context keyword**, which is what a rule's `appliesTo` resolves against.

The last one was the same hole one level down. Scoping was hashed from the first version and the
table it points at was not, so a scoped rule could be silenced everywhere — or made to fire
everywhere — without moving the digest. A rule that stops running reports nothing, which reads
exactly like a page with nothing wrong.

Computed from the build rather than the source, so a comment, a rename, or a reformat cannot make the
baseline stale, and a pattern that reaches the runtime always does. Patterns are sorted before
hashing, because the order a set is tried in does not change what the set matches.

**An absent digest is a refusal, not a pass.** A malformed value is reported as malformed rather than
compared, because comparing it would report "detection changed" — which reads as a finding and is not
one.

**What it still does not cover:** a rule's `evaluate` body. `obstruction/confirmshaming` requires an
interactive control as well as a dictionary match, and changing that requirement changes detection
without moving the digest. It is written down here rather than left for someone to find.

### What used to happen here, and why it does not

For one release, a rule change required a protected GitHub environment, a `workflow_dispatch`, and a
maintainer clicking **Review deployments → Approve**; a workflow then wrote an approval packet
recording who approved, when, and in which run.

It was the wrong instrument for the job. Four dispatches produced four defects, then an escape hatch
for approving changes to the approval tooling itself, then an approval commit that does not
re-trigger CI, and finally a state where ordinary development could not proceed without an operator
at the keyboard. It had stopped checking the rules and started checking availability.

Protected environments remain where the risk is actually external and irreversible: `publish-sdk.yml`,
releases, and anything using publish credentials. Those are unchanged.

`reviewExceptions` are reserved for explicit review gaps. They carry `id`, `scope`, `status`, `owner`,
`reason`, and `resolutionCriteria` — nothing else. `status` is `open` or `resolved`, and a stable rule
with an open exception fails CI.

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
`pnpm rules:reviews:check`. No separate approval step stands between a reviewed pull request and a
stable rule.

Before SDK publication, the governance migration is allowed to be source-breaking for RulePack
authors because the beta has not shipped. After publication, adding required metadata fields must
follow the package semver policy and include migration notes.

Deprecated rules may remain in stable or experimental packs when they carry valid `deprecation`
metadata. Deprecation alone should not change runtime gating: a previously experimental rule may
remain opt-in, and a previously non-experimental rule may preserve its existing default enablement.
