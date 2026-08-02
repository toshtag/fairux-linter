# FairUX status

This document is the source of truth for what is implemented, publish-ready, and unpublished. The
implementation order ahead lives in the [roadmap](roadmap.md). It intentionally avoids treating
"no findings" as proof that a page is fair, legal, or safe.

## Implemented in this repository

- Runtime-agnostic normalized UI model.
- Deterministic rule engine with the built-in FairUX rule pack.
- HTML, DOM, AST/JSX, and Figma JSON adapters.
- CLI, GitHub Actions/SARIF output, Chrome extension, and VS Code extension surfaces.
- JSON, Markdown, SARIF, and HTML report output. The HTML report is a single self-contained file —
  no script, no external asset, no remote URL — so it renders as an artifact or an attachment and
  cannot report back on what was scanned. Every value reaching it is escaped on the only path
  available, because evidence snippets are untrusted markup from the scanned page; the escaping is
  checked by parsing the output rather than by matching substrings, which is what distinguishes "an
  attribute exists" from "those characters appear as text".
- `fairux rules`, listing the rule set a scan would run with its effective state. The activation is
  `@fairux/core`'s `resolveRuleActivations`, which `scan()` also uses, so the listing cannot disagree
  with the scan beside it. It reports enablement, not coverage: a page-context-scoped rule is
  enabled and still silent where it does not apply, and the output says so.
- `fairux explain <rule-id>`, printing one rule's generated governance record: maturity,
  capabilities, jurisdictions, official sources with publisher and review date, and its known
  limitations — placed above the citations, because they are what decides whether a finding is worth
  acting on. A record stating no limitations says so rather than omitting the section. Jurisdictions
  and sources are labelled review context, and the disclaimer is printed rather than assumed.
- `--rule-pack <path>` on `scan`, `rules`, and `explain`, composing external RulePacks with the
  built-in one through `composeRulePacks` — so a malformed pack, a duplicate pack id, or a rule id
  colliding with a built-in one is refused before anything is scanned. Loading is explicit per
  invocation, with no auto-discovery and no config key, because a RulePack is executable JavaScript
  that FairUX does not sandbox and a discovered config would make cloning a repository enough to run
  its code. Every composed pack is recorded in the report envelope and in SARIF's rule metadata.
- `.fairuxignore` path exclusion for directory walks and globs, discovered from the scan's base and
  bypassable with `--no-ignore`. An explicitly named file is always scanned — naming one is an
  instruction. The grammar is a documented subset of gitignore's; an unsupported pattern is refused
  with its line number rather than matched approximately, patterns that matched nothing are reported
  on stderr, and a scan that ends with no files names the ignore file as the reason. Nested ignore
  files and `.gitignore` are deliberately not read.
- Baselines: `--write-baseline <file>` records a scan's findings, `--baseline <file>` subtracts them
  from what is reported and from what `--fail-on` considers. Keyed on `fingerprints.fairuxV1`, which
  survives a line moving but not the surrounding markup being restructured — stated in the file
  itself rather than left to be discovered. A baseline is accepted risk, not resolved risk: every
  run reports how many findings it hid, including zero, and which recorded findings no longer appear.
  A normal scan never rewrites the file.
- Suppressions: `--suppress <file>` removes individual findings from the report and from `--fail-on`.
  Each entry requires a non-empty reason — one without it is a disabled rule with extra steps, and
  the config already disables rules — and may carry an `expiresOn` that is enforced, with the lapse
  reported rather than silent. Every run prints what was suppressed and why, plus expired and unused
  entries. Applied before the baseline, so a finding covered by both is attributed to the one that
  carries an argument.
- Inline suppression comments — `fairux-disable-next-line <rule-id> -- <reason>` — in HTML and
  JSX/TSX, the inputs that have both comments and line numbers. The reason is required here as well;
  a malformed or unmatched directive is reported rather than silently suppressing nothing, because a
  user who wrote one and got silence would believe a finding was accepted when it was not. It applies
  to the next line only, and only to the rule it names. There is no file-level `fairux-disable`.
  Applied in `scan()`, so every surface gets it, and recorded in the report as `suppressed` and
  `suppressionDiagnostics` — additive, and absent rather than empty when nothing happened. Closes
  [issue #104](https://github.com/toshtag/fairux-linter/issues/104).
- Per-scan coverage. Every rule declares the capabilities it needs; a scan resolves what its input
  can supply and skips a rule whose requirements it cannot meet, rather than running it against
  evidence that does not exist and reporting the silence as no findings. `FairUxReport.coverage`
  names the capabilities available and unavailable, and accounts for every rule in the composed set
  as executed or skipped with one of three reasons — the configuration did not enable it, the input
  could not supply what it requires, or the page is not the context it is scoped to. A rule that ran
  without its *optional* capabilities is recorded as the weaker pass it is. The per-runtime baseline
  lives in `@fairux/core` and each adapter checks its own row against a document it parsed, so the
  table cannot drift into a second description of the adapters: the live DOM proves `dom-state` with
  a box ticked after load and no attribute written back, Figma proves it has nothing backing
  `style-hints`, and both prove they supply no source location. A batch report keeps coverage per
  input rather than merging it, because two inputs in one directory did not check the same things.
  It is a description, not a score: no percentage, no grade, and full coverage with zero findings is
  still not a statement that a page is fair.
- Coverage is rendered in every output, not only JSON: a Markdown section, an HTML panel, and
  `run.properties.fairux.coverage` in SARIF — property-bag data rather than a SARIF notification,
  because GitHub surfaces notifications and a rule skipped for a missing capability is a fact about
  the input rather than a failure of the run. Markdown and HTML both had the same defect on the path
  that matters most, and both are fixed: a report with no findings used to return one sentence and
  render nothing about how much had been looked at. No format renders a ratio or a percentage; the
  tests assert that none survives anywhere in the output. `fairux rules --runtime <runtime>`
  answers the part that needs no scan — which rules an input of that kind could never run, and what
  they would need — from the same table the engine resolves against, and still refuses to call the
  enabled set coverage.
- Live visual facts from the DOM adapter, on request. `parseDocument(doc, { visualFacts: true })`
  reads what the rendering engine resolved — a fixed seven-property list and the element's box — and
  the document then declares `computed-style` and `viewport`, so a scan's coverage reports them as
  available. Off by default because each read forces layout and a page can hold thousands of
  elements; claimed only when actually read, because declaring the capability with the values absent
  would let a rule run, see nothing, and report the silence as a result. The property list is fixed
  and the geometry is rounded to whole pixels: a full CSSOM snapshot differs between engines, and
  sub-pixel values move with zoom and device pixel ratio, so neither would compare with itself
  between two scans of an unchanged page. Reachable through `@fairux/sdk/dom`, and on in the Chrome
  extension — the one surface with a rendering engine and a page in front of a user. No rule reads
  these yet: every built-in rule's review record sits under a checked baseline, so
  spending the capability is a separate maintainer decision.
- Form behaviour from the DOM adapter, on request. `parseDocument(doc, { formFacts: true })` records
  whether each control participates in constraint validation, which constraints it currently fails,
  and which form owns it — the owner resolved by the engine rather than by ancestry, because a
  control tied to a form with the `form` attribute lives outside it in the tree. A control barred
  from validation records no failed constraints even though the engine computes them: it is not
  failing anything in effect, and reporting it would say a field blocks submission when it cannot.
  The authored `required` stays in `attributes`, so "asked for but not enforced" is still readable —
  which is the pair markup alone cannot show. Opt-in and claimed only when read, separately from the
  visual facts; the two compose. No rule reads them yet, for the same maintainer-review reason.
- Journeys, as a contract separate from `scan()`. `scanJourney` in the engine and `scanHtmlJourney`
  in `@fairux/sdk/html` take an ordered flow of documents the caller already has; `scan()` still
  takes exactly one document, because an API accepting either would complicate the input, the
  output, and every surface that renders them. A step carries a stable id, an explicit order, the
  document, where it sat, and what the user did — and no selector, wait condition, or credential,
  because nothing here drives a browser and a contract accepting driver instructions would imply one
  exists. An empty journey, a duplicate step id, a duplicate order, and a step with no document are
  refused before any step runs; a step that fails takes the journey with it, since half a flow
  reported as a whole one would say a cancellation path was checked when only its first page was.
  The output has two disjoint layers: every step's own report unchanged, and the findings that exist
  only across steps. Identity is settled up front — each piece of a journey finding's evidence names
  its step, the step is folded into the fingerprint so the same shape at two points of a flow is two
  findings, and `stepId` is rejected on the single-document path. Journey rules live in a RulePack's
  `journeyRules`, must declare the `journey` capability, and see capabilities that are the
  intersection of the steps'. **No built-in journey rule ships**: the contract is what exists.
- The Risk Index **contract**, without a model. `computeRiskIndex` takes a single, batch, or journey
  report and returns its own document with three states, of which only `sufficient` carries a number.
  There is no provisional zero and no midpoint on any unscored path: `score` and `confidence` are
  both null and a reason code says which of "check more" and "ask differently" applies. Coverage and
  confidence are separate fields and neither derives from the other. The schema, model, rule pack,
  and tool versions travel together, and a caller demanding a model version is refused rather than
  answered by whatever model is present. Contributing findings are sorted by fingerprint, so the
  order rules ran in cannot move the report. Every human surface reads one shared view, because one
  renderer printing `0` for a null score would undo the contract and nothing about the output would
  look wrong; SARIF carries the index as run-level property data and never as a result, and a
  contract test fails if the CLI ever reads a score, so the exit-code question has to be decided
  deliberately rather than inherited. **No model ships**: every call returns `unsupported` with
  `no-model`, which is this build's accurate state. The formula, weights, confidence computation,
  thresholds, grades, and corpus calibration are a separate change with its own evidence and owner
  decision.
- The first Risk Index model, `fairux-risk/1`, shipped beside the rules rather than inside the
  engine, because the weights are policy. Each finding contributes its severity weight damped by its
  confidence; each input sums its own; the report takes the **worst single input**, capped at 100.
  Every constant carries the sentence that argues for it in
  [the model document](risk-index-model.md), and the ratios are the claim rather than the numbers:
  one high finding is worth two mediums, because many trivial findings outweighing one serious one is
  the failure a risk number is most often criticised for. The measured behaviour is generated and
  checked in CI: among the corpus pages the rules **detected**, every one scores above every clean
  page, with a margin of 2. A page whose problem was never detected scores 0 and is listed rather
  than folded in — no arrangement of weights can rank a page whose problem was never found, and
  counting it here would report a recall failure as a scoring one. The sensitivity analysis
  re-measures separation under six single-change weight variants and reports the useful result: it
  survives every change to the severity ladder and fails when low-confidence findings are dropped, so
  the severity ratios are not load-bearing on this corpus and the confidence floor is. `@fairux/sdk`
  defaults to this model the way scanning defaults to the built-in pack; `@fairux/core` alone still
  answers `unsupported`. The CLI still does not read a score, and a contract test fails if it starts.
- A second model, `fairux-risk/2`, answers the one thing measurement could settle
  ([issue #134](https://github.com/toshtag/fairux-linter/issues/134)): the same weights, and an
  aggregation that raises the worst input by how many inputs carry findings, doubling at sixteen. It
  counts affected inputs and never reads how many were scanned, which is what keeps ten more clean
  pages from lowering the number — the two candidates that read a denominator both do, measurably
  (60 → 24 and 20 → 0). It scores every single-page input exactly as `fairux-risk/1` does, so the two
  agree wherever breadth is not a question and diverge only where comparing them would be a mistake.
  **It is not the default.** Two scores are comparable when their `modelVersion` matches, so moving
  the default changes what every number written before it meant; `--risk-index-model fairux-risk/2`
  and `computeRiskIndex(report, { model: fairuxRiskIndexModelV2 })` are how it is reached.
- The Risk Index reaches a user: `fairux scan --risk-index <file>` writes it for exactly the report
  the scan emitted — after suppressions, after a baseline — and never to stdout, so nothing that
  parses today's output changes; a test compares the JSON output with and without the flag byte for
  byte. The one line on stderr goes through the shared view, so the CLI cannot print a number for an
  unscored report, and it says what the number is not in the same breath as the number. With
  `--format html` the report shows a panel whose limitations sit with the score rather than below the
  findings. **The exit code is unchanged, and now proven so behaviourally**: the CLI is run against a
  page that scores while `--fail-on high` does not fire, and exits 0. The source-level guard that
  forced this decision to be made rather than inherited has been replaced by that test, keeping only
  what behaviour cannot show — that no flag exists which would gate the exit code on a score, and
  that the decision path cannot see one.
- A remediation schema, with nothing that applies one. A rule may attach a `Remediation` to a
  finding: one file, a checksum of the contents it was computed against, and edits that each carry
  the text they expect to replace — a range alone is a bet that nothing moved between the scan and
  the write, and that bet is lost quietly. `safe` and `review-required` are declared in the data
  rather than judged at apply time, and `rationale` is required for both, because a `safe` label
  needs an argument more than a cautious one does. **An `ai`-origin remediation cannot be `safe`**,
  refused in validation: that makes "AI-generated edits are never auto-applied" a rule rather than a
  promise, and the gate exists before M6 adds the thing it gates. Validated the way evidence is, and
  re-validated on the way out of a rule. No built-in rule produces one — that is a rule change, and
  it needs a maintainer review.
- Applying a remediation, with the refusals that make it safe to have. `applyRemediations` is a pure
  function in `@fairux/core` — the caller supplies the contents and the checksum, because hashing
  belongs where the I/O does and the package is browser-safe — and it refuses six ways: not `safe`,
  an AI origin, a checksum that no longer matches, a range outside the file, text that is not what
  the edit expected, and overlapping edits. A remediation is all-or-nothing: one refused edit means
  none of it applies, because a partly applied fix leaves a file in a state neither the author nor
  the tool intended. `fairux scan --fix-dry-run` and `--fix-write` share one plan and differ in one
  branch, so what a user was shown is what a user gets; neither changes stdout or the exit code,
  since whether a fix existed says nothing about whether a finding should fail the build. There is no
  flag that applies a `review-required` remediation, and the absence is recorded in the options type
  where a future one would have to be argued for.
- An AI augmentation contract, with no provider and no network call. An observation lives in
  `aiAugmentation` and never in `findings`: it has no fingerprint, rule id, or severity, and a
  provider that attaches one is refused rather than trimmed. It cannot fail a build — a contract test
  runs `--fail-on` over a report whose only signal is an observation, at every threshold. What a
  provider would receive is assembled from an **allowlist** — normalized text, tag names, detected
  page contexts — with no attributes and no file paths, and the test that matters adds a field to
  every node and shows the payload does not grow. A provider races a timer and can therefore fail,
  hang, or answer with nonsense without taking the scan with it; a runtime with no timer refuses to
  call one at all. Provider-neutral, and checked: the contract file imports nothing but its own
  types and names no vendor.
- An inventory of the published SDK surface, generated from the **built declarations** a consumer's
  TypeScript reads rather than from source — an inventory generated from `src` would agree with the
  code and could still disagree with the package. 136 exports across the three entry points, checked
  in and verified in CI. The check separates the two things that used to look identical in a diff: a
  removed or renamed export fails it and is named as a break, while an addition is reported, passes,
  and makes the artifact stale so the existing worktree-cleanliness gate turns it into a diff
  somebody reads. The comparison itself is mutation-tested — removal, rename, a value becoming a
  type, a missing entry point, and a pure addition — because a check that passes on everything reads
  exactly like one that works.
- Written compatibility guarantees and a deprecation policy
  ([compatibility](compatibility.md)), covering what is public, what an additive change is, what a
  breaking one costs, and the rule that nothing is removed without being deprecated first. The
  document says which of its guarantees are checked and which rest on review, because a policy
  claiming to be fully mechanised would be less honest than one that admits the split. The inventory
  records deprecation, so a removal reports whether it was deprecated first; the report schema's
  documented fields are pinned through the type system rather than by reading the prose, which
  checks that the document describes what a consumer receives rather than that two documents agree.
- Documented [supported platforms](supported-platforms.md), asserted against every package's
  `engines` and every CI matrix — the Node floors lived in three places and nothing noticed when they
  disagreed. macOS is named as untested rather than implied to work, and Windows is in CI because it
  broke.
- An explicit [security boundary](security-boundary.md) in one page: what is untrusted (everything in
  a scanned page, and a rule id from an external pack), what is trusted and stated rather than
  implied (a third-party RulePack is unsandboxed code that can read the filesystem), and the five
  things FairUX will not do — return a verdict, classify by site vocabulary, auto-apply an
  AI-suggested edit, let an AI signal fail a build, or send anything that was not on an allowlist. It
  ends by admitting there has been no third-party security review, because a page listing only its
  defences reads like a claim to have been tested.
- Written [1.0 release criteria](release-criteria-1.0.md), as a measurement rather than a verdict.
  Every criterion is met with evidence a test confirms exists, or open with what it needs. How many
  are open is not repeated here: this line said six, `P6` closed, and nobody re-read the sentence
  while closing it. That document gathers its own open items and a test fails if the gathering and
  the table disagree, which is one place to be wrong instead of two. The two nearest are still the
  npmjs.com owner actions M1 recorded.
- `@fairux/sdk` root, HTML, and DOM entry points.
- RulePack composition with versioning, provenance, overrides, and packed consumer smoke tests.
- Extensible RulePack taxonomy metadata for namespaced external categories and page contexts.
- RulePack authoring kit for external authors: authoring guide, testing guide, taxonomy migration
  notes, copyable example package, and valid/invalid authoring fixtures.
- Rule governance metadata has an accepted and hardened ADR covering maturity, provider-neutral
  capability vocabulary, optional capabilities, evidence requirements, jurisdiction context,
  official source identity versus review metadata, pack-local deprecation replacement, deprecated
  rule pack eligibility, known limitations, public SDK authoring boundaries, and review workflow
  boundaries. The public `RuleMeta` fields, strict RulePack validation, SDK type mirror, immutable
  snapshots, additive SARIF rule metadata, authoring fixtures, and minimal built-in rule governance
  metadata are implemented.
- The SDK tarball and registry consumer smoke path compiles the negative public governance
  TypeScript fixture against emitted declarations and exercises the full governance metadata
  contract, including nested freeze, mutation isolation, and invalid governance rejection.
- Built-in rule review foundation now has a schema-v2 machine-readable official-source identity
  catalog and 13 prepared review records. Source identity is separated from catalog metadata and
  rule-specific source review mappings. The records carry rule version provenance, rule
  jurisdictions, executable positive and negative corpus evidence, uncovered scenarios, locale,
  runtime, false-positive, evidence usefulness, performance, determinism, and non-empty limitation
  notes. The fail-closed `pnpm rules:reviews:check` validator reads built runtime metadata, checks
  version parity and corpus test references, shares the core jurisdiction and SemVer contracts,
  rejects `UK` aliases in favor of `GB`, validates structured review exceptions, and does not treat
  prepared records as maintainer approvals. Review provenance validation now also checks source
  publication status against `supportKind`, requires status notes for non-current sources, rejects
  template mapping notes and broad-only source locators, and treats current 16 CFR Part 425 as
  contextual support limited to prenotification negative option plans. The review data also records
  EDPB consent mappings as EU and EEA context, keeps visual-prominence direct support on sources
  that address equal prominence or concrete UI treatment, and avoids treating scarcity wording as a
  truth determination.
- Built-in rule governance is generated from the prepared review records. Runtime metadata now
  carries review-derived maturity, jurisdictions, current official sources, and known limitations
  for all 13 built-in rules. Non-current source records, including the vacated FTC 2024 Negative
  Option final rule and proposed 2026 ANPRM, are excluded from runtime `officialSources` and kept in
  the deterministic generated catalog as review provenance. Generated governance and catalog
  artifacts are checked in CI, generated only after fail-closed review validation succeeds, and the
  catalog is rendered from the built `fairuxBuiltinRulePack` runtime metadata rather than
  TypeScript source parsing. Catalog generation now exact-compares actual runtime governance
  against a review-derived projection for every built-in rule before writing artifacts, covering
  maturity, jurisdictions, official-source identity/review fields, source order, and known
  limitations. Behavior contract tests pin built-in rule order, enablement, experimental status,
  execution metadata, representative finding IDs, counts, severity, confidence, and fingerprints.
  SARIF tests verify actual stable and experimental built-in governance without generic help URIs,
  and packed SDK smoke tests compare all 13 installed-tarball built-in rule contracts against the
  generated catalog while keeping non-current and generic FTC blog references out of runtime
  governance. The generated maintainer catalog includes linked source provenance, rule
  jurisdictions, tags, applies-to metadata, source review dates, support kinds, locators,
  limitations, and status notes. See [built-in rule catalog](rules.md) and
  [`docs/generated/rule-catalog.json`](generated/rule-catalog.json).
- Built-in rule review is closed out with an explicit maintainer decision. All 11 stable review
  records are covered by the baseline; the 2 experimental records were reviewed and deliberately kept
  `prepared`, `experimental`, and default-off. 13 uncovered scenarios are acknowledged as known,
  non-exhaustive coverage boundaries, and there are no approved open review exceptions. The decision
  is recorded in the [P13 maintainer review packet](reviews/P13-built-in-rule-maintainer-review.md),
  which is history. What CI enforces now is
  `packages/rules/reviews/rule-review-baseline.json`: a fingerprint over the review records, a digest
  over what the rules detect, and each stable rule's shipped version. `pnpm rules:reviews:check`
  re-verifies it on every run, so adding or changing a stable built-in rule without saying so fails
  CI. The approval machinery that briefly sat on top of this — a protected environment and a human
  approval event for a change with no external side effect — was removed; it guarded availability
  rather than correctness.
- Build output is deterministic and release-safe. TypeScript configuration is split into a
  typecheck contract (`tsconfig.json`, `noEmit`) and a per-package declaration-emit contract
  (`tsconfig.build.json`, scoped to `src`), so a build cannot write into a source tree. The
  fail-closed `pnpm check:build-output` asserts that nothing at all lands below a `dist` directory
  that is not the output directory of a workspace discovered from its manifest — regardless of file
  type, since a directory that is not a build directory explains a `.json` or `.html` no better
  than a `.js` — that no compiler output lands in a source tree or elsewhere outside `dist/`, that
  hand-written `.mjs`/`.d.mts` files are
  allowed only at exact paths already tracked in the Git index, that every package declares its
  type entries under `dist/` and ships them, that the SDK ships all three published entry points,
  and that the CLI still publishes none. The check does not lean on `git status`, which is blind
  here because `.gitignore` ignores `dist/` at any depth, and it aborts rather than passing when a
  directory or the Git index cannot be read. The import that triggered the
  pollution — one workspace reaching into another's private `src/` — is enforced by TypeScript
  itself: `rootDir` on each package makes an emit-relevant foreign source file a `TS6059` error
  during `pnpm typecheck`, covering static, dynamic, import-equals, and directory imports. Because
  the check reads the compiler's resolved program rather than source text, strings, comments,
  regular expressions, and JSX text cannot be reported as violations. CI additionally lints *after*
  building and
  builds twice on Node.js 22.18.0 and 24.11.0, comparing artifact digests. See
  [SDK beta release runbook](sdk-beta-release.md#build-output-contract).
- Extensible taxonomy hardening is verified for deterministic RulePack composition, immutable
  composed taxonomy snapshots, root/HTML/DOM page-context signals, external category preservation in
  JSON/Markdown/SARIF, and RFC 5646 locale syntax boundaries under Node.js 22.18.0 and 24.15.0.
- Detection quality is measured rather than asserted case by case. 33 labelled pages in `corpus/`,
  English and Japanese, one positive per stable rule and nineteen that should produce nothing — seven
  of those adversarial, written to be pages a rule has a reason to fire on and should not — the
  negatives being the half that catches a rule firing where it should not, held at no less than 40%
  of the corpus by a test. The label says what a page should produce, decided from the page; when the
  engine disagrees the disagreement is recorded rather than relabelled, which is the only thing that
  keeps the numbers from being circular. The result is generated into
  [corpus evaluation](generated/corpus-evaluation.md) and checked in CI the way the rule catalog is,
  so a change in detection quality arrives as a diff. The first run recorded one tolerated borderline
  and one miss — `no thanks, I don't like saving money` was not detected as confirmshaming — and the
  miss stood through four milestones, because changing what a rule detects needs a version bump, a
  review-record update, and a regenerated baseline. It is closed in
  `obstruction/confirmshaming@1.1.0` ([issue #121](https://github.com/toshtag/fairux-linter/issues/121)),
  by that route and not by editing the label. Three of the seven adversarial pages found false positives on their first run — five
  confirmshaming ([issue #161](https://github.com/toshtag/fairux-linter/issues/161), fixed in
  `obstruction/confirmshaming@1.1.0`: the English pattern removed as redundant, the Japanese one
  replaced by a pattern that names the benefit rather than matching anything after `いいえ`) and one
  where a
  free newsletter signup reads as a paid subscription
  ([issue #162](https://github.com/toshtag/fairux-linter/issues/162), fixed in
  `subscription/cta-without-cancellation-context@1.1.0` — `subscribe` alone no longer puts a page in
  the subscription context, because a free mailing list uses the word as often as a paid plan and has
  no plan to cancel).

  Seven rule defects have now been found this way, including one that made a rule stay **silent** on
  the page it exists for. Precision read 1.000 after the last of them, which meant only that no page
  here disagreed with the rules — it had read 1.000 immediately before three of the seven were found.

  The eighth was found by six pages nobody here wrote
  ([#203](https://github.com/toshtag/fairux-linter/issues/203), landed;
  [#206](https://github.com/toshtag/fairux-linter/issues/206), fixed in
  `obstruction/modal-without-close-action@1.2.0` and `obstruction/modal-close-visibility@1.1.0`).
  `isModalLike` matched any class token *containing* `modal` or `dialog`, so Bootstrap's
  `modal-body` and a BEM `…__close` were each reported as a modal with no way out — the close button
  among them, 11 findings on two pages that both close. A class token now names a modal only when
  the hint word is its last word, and only the outermost modal-like node of a chain is checked.
  Seven adversarial pages written here never found it, because their markup was chosen by somebody
  who knew what the rule reads. Precision is **1.000** over 56 pages again — the same claim it was
  before, over six pages more, and it still describes the pages in `corpus/manifest.json` and bounds
  nothing about pages nobody here has seen.
- The rule-review gate binds to what the rules **do**, not only to what the records say.
  It did not until now: the review fingerprint hashes the review records and the `ruleVersion` each
  one declares, so widening a dictionary pattern without touching a version passed
  `rules:reviews:check`, `rules:catalog:check`, `eval:corpus:check`,
  and the whole test suite — measured, with a stable rule detecting something nobody had reviewed. The
  baseline now records a `detectionDigest` over every dictionary pattern and every rule's execution
  metadata, every page-context keyword, and every rule's **behaviour** over a frozen probe set —
  taken from the build, so a comment or a reformat cannot make it stale and a phrase that reaches the
  runtime always does. The behaviour half reaches a rule's `evaluate` body: removing
  `obstruction/confirmshaming`'s interactive-control guard changes no pattern, no version and no
  keyword, and now fails the check, which was verified by removing it. The keyword table was the
  same hole one level down: a rule's `appliesTo` was hashed and the table it resolves against was
  not, so a scoped rule could be silenced everywhere without moving anything. A malformed digest is a
  refusal rather than a pass. What it still does not cover is a change no probe exercises, which is
  written down rather than left to be found.
- A rule change lands as an ordinary pull request. It briefly did not: for one release it needed a
  protected GitHub environment, a `workflow_dispatch`, and a maintainer clicking **Review deployments
  → Approve**, for a change with no publish, no deployment, no secret, and no destructive external
  effect. Four dispatches produced four defects, then an escape hatch so that a change to the approval
  tooling could be approved by tooling that predated it, then a state where ordinary development could
  not proceed without an operator at the keyboard — it had stopped checking the rules and started
  checking availability. What replaced it is `pnpm rules:reviews:update` and a checked baseline; what
  a maintainer does is read the diff. Protected environments remain on publish and release, which is
  where the irreversible external effect actually is.
- Local browser execution without network or AI dependencies in the FairUX core.

## Published beta

### SDK publication state

| Package version | npm state |
| --- | --- |
| `@fairux/sdk@0.1.0-beta.3` | **published** |

This table is the machine-checked record. `pnpm release:check:sdk` reads exactly one row from it and
requires the package and version to equal the SDK manifest's, so the prose below cannot drift away
from the version being released. The prose that follows explains the row; it does not establish it.

**`0.1.0-beta.3` is published.** The manifest bump and the narrowed description — the two things
[issue #69](https://github.com/toshtag/fairux-linter/issues/69) requires be done together, since
changing the description alone would make the repository disagree with metadata already on npm for
`0.1.0-beta.2` — reached the registry in
[run 30691990236](https://github.com/toshtag/fairux-linter/actions/runs/30691990236) from tag
`sdk-v0.1.0-beta.3` at commit `853b0543c029ffe4a45db01424ffd6e04a9420d1`. `npm view` now returns the
narrowed description for the exact version, which is the read-back #69 asks for. `0.1.0-beta.2` was
not rewritten, re-tagged, or re-released; `next` moved to `0.1.0-beta.3` and no other dist-tag moved
at all, verified against a snapshot taken before the publish rather than against the current values
alone. The measured evidence is in the
[SDK beta release runbook](sdk-beta-release.md#closeout-evidence--010-beta3).

- `@fairux/sdk@0.1.0-beta.2` is published on npm under the `next` dist-tag, with SLSA provenance,
  a GitHub Release carrying the tarball and its checksum, and clean public-registry install smoke
  evidence on Node.js 22.18.0 and 24.11.0 — no local tarball fallback and no workspace specifier.
  `latest` still points at `0.0.0-bootstrap.0`; the beta is opt-in.
  It took three attempts ([run 30258382164](https://github.com/toshtag/fairux-linter/actions/runs/30258382164)),
  the last of which found the version already present with a matching digest, skipped the publish,
  and created the Release. The second attempt published successfully and was recorded as a failure
  because the digest verification, starting in the same second, read the version as absent — fixed
  in P20-T4 with a bounded absent-only wait under a monotonic 120-second deadline
  ([issue #62](https://github.com/toshtag/fairux-linter/issues/62)). The release path is beta-only,
  rerunnable after matching partial npm publication, and source-map publication is disabled for the
  SDK beta. See the [SDK beta release runbook](sdk-beta-release.md) for the full attempt history.
- P20 is closed. [Issue #63](https://github.com/toshtag/fairux-linter/issues/63) is resolved on both
  halves. The repository half, in P20-T7, made the Release notes generator a pure function whose
  release-variable facts come only from the trusted checkout and from values the privileged publish
  job verified, emitting structured user-facing sections instead of a flat bullet list, titling
  future Releases without duplicating the version's `v`, and describing the published beta in the
  SDK and root READMEs. The external half corrected the published `sdk-v0.1.0-beta.2` Release in
  place with `gh release edit` alone — title and body only, once. Rereading it afterwards, the
  published title and body match the notes regenerated from the manifest at the commit its tag
  resolves to, and the tag, target commit, prerelease flag, both assets, npm metadata, and dist-tags
  are unchanged. The rendered page was checked to its footer as a separate, non-machine step. No
  release execution was rerun: nothing was published, uploaded, deleted, retagged, or re-tagged for
  a dist-tag. The record is in the
  [SDK beta release runbook](sdk-beta-release.md#closeout-evidence--external_correction_verified).
- P20-T8 closes [issue #68](https://github.com/toshtag/fairux-linter/issues/68): one shared
  `isBetaPrerelease` contract now backs the workflow's earliest tag gate, the release check, the
  bundle assembler, and the bundle verifier, so `0.1.0-alpha.1`, `0.1.0-rc.1`, and the purely
  numeric `0.1.0-1` are refused where four gates previously called them beta. The repository-wide
  stable-is-`latest`, prerelease-is-`next` dist-tag policy, which also governs the CLI, is
  unchanged.
- The SDK release path now verifies its own provenance claim and no longer asserts anything it was
  not given evidence for, closing
  [issue #83](https://github.com/toshtag/fairux-linter/issues/83). The workflow reads
  `dist.attestations` back from the registry after publishing — the CLI path has done this since
  M1-R2, the SDK's did not — and the notes generator takes verified facts rather than prose. The one
  sentence that stood for three things is three claims: the authentication mechanism, which the
  checkout establishes; the credential preflight; and the registry's provenance record. The last two
  are asserted only when the privileged job passes a flag for a step that actually ran, and narrow
  to "unverified here" otherwise. There is no negating form, because a failed check fails the job.
- [Issue #69](https://github.com/toshtag/fairux-linter/issues/69) narrowed the SDK package
  description. It could not be fixed in place: `0.1.0-beta.2` was already published, so changing the
  manifest alone would have left the source disagreeing with the registry metadata for the same
  version. It is resolved at the next published SDK version, as planned — `npm view
  @fairux/sdk@0.1.0-beta.3 description` returns the narrowed text, which is the read-back the issue
  asks for rather than the manifest edit that preceded it.
- `fairux@0.1.0-beta.1` is configured as a CLI package, but public registry availability still
  depends on the beta publishing workflow and release verification.
- The CLI's repository-side release contract is implemented and **not yet executed**: the tag and
  manifest gates, a source-map policy the packed tarball is audited against, an idempotent
  publication plan (absent → publish, matching digest → skip, conflicting digest → fail),
  post-publish digest and dist-tag verification, generated release notes, and a create-or-repair
  GitHub Release. `pnpm release:check:cli` and `pnpm release:dry-run:cli` rehearse the whole path
  with no registry and no tag, and CI runs the dry run on both Node.js floors.
- The packed CLI is verified on Linux and Windows, the two platform targets required by M1-R3.
  `pack-smoke` on `ubuntu-latest` and `pack-smoke-windows` on `windows-latest` each run
  `pnpm pack:smoke` on
  Node.js 22.18.0 and 24.11.0: pack, audit the archive, install into a clean project, and run the
  published CLI's behaviour contract through the executable npm generated — `fairux.cmd` on
  Windows, not `node dist/index.js`. Both platforms run the same archive audit and the same
  installed-CLI contract, which covers identity, the HTML/JSX/TSX adapters, stdin/file/directory/
  glob targets, Markdown/JSON/SARIF output, config auto-discovery, an explicit trusted config, and
  exit codes 0/1/2; report and SARIF paths are asserted to carry no drive letter, backslash, or
  absolute temporary directory, so a Windows run cannot change a published identity. Reaching that
  required the audit to stop depending on `sha256sum`, `sh`, and an external `tar`, which is why
  the archive is now read with Node built-ins. The installed-CLI contract takes an
  already-installed CLI, so the registry-installed smoke can reuse it unchanged. The Windows job
  grants only `contents: read`; naming any job-level permission sets every other one to `none`, so
  the job's token is read-only by the workflow rather than by repository settings.
- The CLI defect the Windows matrix found is fixed, closing
  [issue #84](https://github.com/toshtag/fairux-linter/issues/84). A glob written with the
  platform's own separator — `fairux scan "inputs\*.html"` — matched nothing, because neither
  `cmd.exe` nor PowerShell expands globs and a backslash in a pattern is an escape character rather
  than a separator. On Windows a backslash in a glob is now a separator: `*`, `?`, `[`, `{`, and
  `\` cannot appear in a Windows filename, so no name there could only have been written with an
  escape, and nothing is lost by the translation. Off Windows the pattern is untouched, so
  `a\*.html` still names the single file `a*.html`. UNC, device, and extended-length patterns are
  refused with exit code 2 rather than translated, because the expander does not support them and a
  translation would report an unsupported target as matching nothing; a directory or a direct file
  on the same share is unaffected. The pattern's form is settled once, so expansion and config
  discovery answer for the same set of files. The rules are pure functions taking the platform as an
  argument, so any host settles both platforms' behaviour, and the installed-CLI contract now runs
  the native form beside the portable one on Windows and requires them to name exactly the same
  files — so the registry-installed smoke does not inherit the portable form as the only supported
  one.
- The registry-installed CLI smoke is implemented and **has never run green**, for the same reason
  the release contract has never run: `fairux` does not exist on npm. `pnpm registry:smoke:cli`
  installs one exact version from the public registry into a clean temp project with its own npm
  cache and runs the same `installed-cli-smoke-contract.mjs` the packed smoke runs — the two paths
  differ in provenance and in nothing else. Three things are checked only there: the registry is
  read before the install, so an unpublished CLI reports as unpublished instead of surfacing a 404
  from inside `npm install`; the installed manifest's version must equal the resolved one, so a
  dist-tag that moved cannot let a run pass under the resolved version's name; and
  `npm audit signatures` must report `fairux` as verified against the public registry with a SLSA
  provenance predicate — the independent half of a provenance claim the publish workflow otherwise
  makes about its own API read. `.github/workflows/registry-cli-smoke.yml` runs it weekly and on
  dispatch across four cells, `ubuntu-latest` and `windows-latest` on Node.js 22.18.0 and 24.11.0,
  with `contents: read` and no `id-token`. Every run today fails with
  `fairux@next is absent on the public registry`, which is the accurate state and is deliberately
  not hidden behind a conditional. The refusals themselves are pure functions with unit coverage, so
  what CI proves today is that they refuse — not that an install succeeded.
- The SARIF upload canary has been **run**, and what GitHub code scanning does with FairUX SARIF is
  now measured rather than assumed. Full record, with run URLs and per-stage evidence:
  [SARIF upload canary](sarif-upload-canary.md).
  - **Alert identity survives a line move.** The same finding, moved from line 12 to line 15 by a
    real commit, stayed alert #1 and stayed `open`. That is what
    [PR #79](https://github.com/toshtag/fairux-linter/pull/79) was betting on when it stopped
    emitting `partialFingerprints.primaryLocationLineHash`, and it holds.
  - **The mechanism was not observed.** `partial_fingerprints` came back `null` on every read; the
    alerts API may simply not expose it. That is not evidence that GitHub generated no fingerprint,
    and this record does not claim it is.
  - **A result that stops being reported becomes `fixed`** — not deleted and not `dismissed`,
    keeping its alert number and last known location.
  - **Logical-only results could not be uploaded at all, and that is fixed.** DOM and Figma findings
    carried `logicalLocations` and no `physicalLocation`, and GitHub fails the *whole submission*
    with `locationFromSarifResult: expected a physical location` — so a scan producing any such
    result uploaded nothing, including the physical-location results beside it. Dropping `locations`
    entirely fails too; only a physical location naming the scanned file is accepted, displayed at
    line 1. A locator-only finding is now anchored to the scanned file, with no `region` and with
    the logical location kept in the same SARIF location, so nothing is given up and the change is
    additive. A scan with no file at all — live DOM — stays logical-only and remains unuploadable,
    which is a property of that input rather than of the reporter.
    [Issue #90](https://github.com/toshtag/fairux-linter/issues/90) is resolved in the repository;
    the fixed shape has **not** been re-measured against code scanning, which is the next canary's
    first job.
  - **The canary's own categories did not take effect.** Four distinct `automationDetails.id` values
    all came back as `category: ""`, because an id with no `/` does not become a category. It failed
    safe — cleanup refuses on an unrecognised analysis — and it does not change the observations
    above, which are about sequential transitions that one shared analysis set produces identically.
    Ownership now rests on the ref, which is unique per run.
  - **GitHub removed the analyses and alerts on its own within three minutes, and why is not
    known.** Nothing in this repository deleted them — the cleanup run failed on the *listing*,
    before it could issue a `DELETE`, which is how the disappearance was found. No mechanism is
    recorded, because none was observed; what carries forward is that a canary must read the state
    it is about to act on rather than the state it created.
  - The canary's analyses are gone and its branch is deleted
    ([cleanup run 30682313365](https://github.com/toshtag/fairux-linter/actions/runs/30682313365),
    `deleted: [], remaining: 0`). `main` had no code scanning analysis before this canary and has
    none now.
- Both publish workflows now refuse an environment that could redirect a release write, and read the
  Release back after writing it: every asset is re-downloaded and hashed against the bundle the run
  audited, rather than trusting the upload or an API digest field. Immutable Releases are
  deliberately **not** enabled — they are incompatible with the rerunnable repair contract that
  exists because a successful publish was once recorded as a failed release, and the read-back
  supplies the tamper-evidence they would have. Recorded in the
  [CLI beta release runbook](cli-beta-release.md), closing
  [issue #82](https://github.com/toshtag/fairux-linter/issues/82).
- Nothing about `fairux` has been published, tagged, or released. The npm package does not exist,
  so its Trusted Publisher record cannot exist either — that is configured on a package's own
  settings page, which is why the name has to be created by a one-off manual bootstrap publish
  first. Both are owner actions on npmjs.com, recorded in the
  [CLI beta release runbook](cli-beta-release.md); this repository cannot verify either of them.
- External products can install the beta SDK from public npm:

  ```bash
  npm install @fairux/sdk@next
  ```

  Every other package in this monorepo — including the `fairux` CLI — stays internal until it is
  released separately, and none of them is a public compatibility contract. The beta SDK's own
  contract is a beta one: it is on the `next` dist-tag, not `latest`.

## Not implemented yet

- Any evidence that `fairux-risk/1`'s weights are right beyond separating the corpus. Six of those
  pages are now ones this project did not write, which was
  [#203](https://github.com/toshtag/fairux-linter/issues/203) — and separation is a *weaker* claim
  than it was, because two of the six are clean pages a rule fired on and the calibration excludes
  those from the comparison by design. It says so, and names them. Breadth is answered by
  `fairux-risk/2` and journey scoring is measured, and neither changes `fairux-risk/1`: a different
  formula is a different model version.
- Network and interaction signals. Every scan reports them as unavailable, which is why no rule
  requiring one can run — and the two are unavailable for different reasons. `interaction` has not
  been built. `network` **will not be** under the current design
  ([issue #126](https://github.com/toshtag/fairux-linter/issues/126)): the extension permission it
  would need is refused — `activeTab` plus `webRequest` can already observe the current tab's
  main-frame requests after a user gesture, so this is a product boundary and not an impossibility;
  what comprehensive observation needs is standing host access, and that is what is declined. A
  manifest test fails if any of ten permissions appears, `optional_permissions` among them. The other three answers bind whatever comes next — observations stay local at
  registrable-domain granularity, they never sit inside a finding's evidence because evidence travels
  into code scanning, and a network signal may back a claim about the interface and never about the
  destination. Resource timing, the API that looks like it would do the job, still cannot explain
  redirects, cache hits, cross-origin iframes, service workers, request bodies, or initiator
  attribution. Live visual facts, form behaviour, and the journey contract are
  implemented; no rule spends any of them yet, because changing what a rule detects needs a fresh
  maintainer review.
- A **built-in** journey rule. `fairux scan-journey <file>` runs a flow named by a journey file and
  `fairux rules` lists journey rules separately, but the built-in pack ships none — writing one is a
  rule change needing a maintainer review. A journey scanned today reports that the flow itself was
  not checked, rather than reporting zero as a clean result. How such a rule's findings would score is
  measured rather than left open ([issue #135](https://github.com/toshtag/fairux-linter/issues/135)):
  a cross-step finding weighs like a page finding, a flow is gated like a page, and **anchoring
  decides the number** — the same finding is worth 10 on the worst step and nothing on a quiet one,
  because `stepId` says both where a reader should look and which input the finding belongs to. A
  first journey rule has to choose its anchor knowing that.
- Journey SARIF and a journey HTML report. Both are refused with their reasons rather than emitted:
  a journey finding has no physical location of its own, and the HTML report renders one document
  with one coverage panel.
- A built-in rule that proposes a fix. One gate is left — a rule change needs a maintainer review.
  The model now carries a source range per attribute where an adapter was asked for one
  (`source-range`), so a browser-safe rule can build a precise edit; the CLI supplies it on every
  scan, and `removeAttributeEdit` builds the edit or returns nothing rather than guessing. JSX/TSX
  supplies none of it yet, deliberately: an attribute value there may be an expression.
- Any AI provider implementation, and the evaluation workflow for one. The contract exists; nothing
  calls anything.
- AI-assisted candidate-rule discovery, which is a workflow rather than part of a scan.
- A sandbox boundary for scanning untrusted file trees.

## Phase record

Development through P18 was tracked in numbered phases. This is the closing record of the last
tracked phases; the ordering principle — the deterministic FairUX core stays separate from
external consumer products — carries over into the [roadmap](roadmap.md):

1. P13 taxonomy and rule governance is complete, through the built-in governance catalog migration
   and explicit maintainer review approval and closeout.
2. P20 SDK beta release is complete. `@fairux/sdk@0.1.0-beta.2` is on npm with provenance, a
   GitHub Release, and registry-installed smoke evidence on both supported Node.js floors. See the
   [SDK beta release runbook](sdk-beta-release.md).
   [Issue #57](https://github.com/toshtag/fairux-linter/issues/57) is resolved,
   [issue #62](https://github.com/toshtag/fairux-linter/issues/62) — a successful publish recorded
   as a failed release — is fixed in P20-T4,
   [issue #63](https://github.com/toshtag/fairux-linter/issues/63) brought the Release notes, the
   published Release itself, and the READMEs in line with the published beta in P20-T7, and
   [issue #68](https://github.com/toshtag/fairux-linter/issues/68) made every SDK publish gate mean
   beta in P20-T8. The CLI was not released in the same wave, so that one condition is recorded as
   non-applicable rather than met.
3. P21 GitHub Actions Node 24 runtime maintenance is complete, and
   [issue #64](https://github.com/toshtag/fairux-linter/issues/64) is closed.
   `pnpm/action-setup` and `actions/download-artifact` run on releases whose own `action.yml`
   declares `node24`, pinned by the commit each tag dereferences to; every workflow action stays
   pinned by full SHA. The `main` CI run on the merge commit
   ([30422201019](https://github.com/toshtag/fairux-linter/actions/runs/30422201019)) has zero
   Node 20 action-runtime warnings, against 14 on the baseline it replaced, and it preserves the
   `packageManager: pnpm@10.33.2` selection on Linux and on Windows, the CLI and SDK artifact names
   and destinations, and the publish privilege and OIDC boundaries. This was bounded maintenance
   ahead of P18, not a change to the product roadmap's priorities.
4. **P18 external consumer integration is complete.**
   - **P18-T1 is complete.** The Purchase Guard boundary is checkable rather than merely stated:
     no built-in rule and no reference Purchase Guard rule may classify by site/security
     vocabulary, the consumer API is `@fairux/sdk`, `@fairux/sdk/html`, and `@fairux/sdk/dom` only,
     and site signals travel beside a `FairUxReport` rather than inside its findings. Enforced by
     `tests/unit/external-consumer-boundary.test.ts`.
   - **P18-T2 is complete.** The registry consumer smoke workflow
     (`.github/workflows/registry-consumer-smoke.yml`) has been observed green on the default
     branch: [run 30550960553](https://github.com/toshtag/fairux-linter/actions/runs/30550960553),
     a `workflow_dispatch` on `main` at `78c4b0ee256a08d3b5fb9acaa3154316a33b7740`. It resolved
     `@fairux/sdk@next` to the exact published `0.1.0-beta.2` against
     `https://registry.npmjs.org/` and passed on both supported Node.js floors, 22.18.0 and
     24.11.0. Each job ran the smoke's registry-consumer profile against the
     `sdk-registry-consumer-v1` contract (minimum SDK `0.1.0-beta.2`, contract SHA-256
     `0169a9efc047fcb31b1e3653dfe728acde3656e26be14b8834d810c2d4f017bb`): a clean registry
     install — no workspace link, no local tarball — then the Node consumer composing the
     built-in pack with a Purchase Guard-style pack, namespaced external categories and page
     contexts, taxonomy freeze and mutation isolation, malformed-pack rejection, the TypeScript
     consumer against emitted declarations, and the browser bundle. The workflow stays in place
     as a weekly, non-required registry canary.

Phase-numbered progress tracking ends here: P18 was the last phase tracked this way, and no new
P-numbers will be assigned. What was previously listed as P14–P19 is now ordered as milestones in
the [roadmap](roadmap.md); the next milestone is the public CLI beta release.

## Product boundary

With the built-in RulePack, and for the same normalized input under the same scanner policy, FairUX
returns deterministic findings carrying evidence, severity, confidence, rule identity, an
explanation of why the issue matters, and a human-readable recommendation. Rule governance metadata
and known limitations live on the RulePack rather than in `FairUxReport`. Third-party RulePacks are
trusted executable JavaScript and are outside that determinism guarantee. FairUX does not return
legal verdicts, fraud verdicts, site safety verdicts, or proof that a UI is fair.

Purchase Guard-style products are separate applications. They may reuse the FairUX SDK and
RulePack contract, but URL, TLS, domain, redirect, reputation, and other site/security signals
belong in their own namespace at the application layer, not inside FairUX findings.

That boundary is enforced, not just described. `tests/unit/external-consumer-boundary.test.ts`
pins the structural half: neither the built-in pack nor this repository's Purchase Guard reference
pack may classify by site vocabulary, the consumer API is `@fairux/sdk`, `@fairux/sdk/html`, and
`@fairux/sdk/dom` only, and site signals travel beside a `FairUxReport` rather than inside its
findings. `.github/workflows/registry-consumer-smoke.yml`, against the versioned registry consumer
fixture, separately proves an exact-version install from public npm actually runs. Neither proof
substitutes for the other.

Two limits on that, stated rather than implied. Arbitrary third-party RulePacks are outside FairUX
governance by construction — the contract binds FairUX's own surface and the example this repository
ships, not someone else's pack. And the structural test shows only what may not be built;
registry-installed proof of a composed Purchase Guard-style pack comes from the
[registry consumer smoke](https://github.com/toshtag/fairux-linter/actions/runs/30550960553)
observed green on the default branch.
