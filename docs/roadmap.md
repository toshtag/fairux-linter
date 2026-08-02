# FairUX roadmap

This is the product roadmap: the implementation order and the dependencies between milestones.
It is not a task ledger — current implementation state lives in [status](status.md) and concrete
work items live in GitHub Issues.

## Current position

- The deterministic engine and the built-in FairUX rule pack are implemented, with governance
  metadata generated from maintainer-approved review records.
- M3 is complete: every report says what it was able to check, and detection quality is measured
  against a labelled corpus rather than asserted. `computed-style`, `viewport`, `form`, and `journey`
  are supplied; no rule spends them yet, because that needs a fresh maintainer review.
- M4 and M5 are complete: a Risk Index with a versioned model that reports no number rather than a
  provisional one, and a remediation schema whose safe fixes can be applied and whose refusals are
  loud. M6's contract is in place with no provider behind it, and M7's repository side is done —
  the public surface is inventoried and checked, compatibility and deprecation are written,
  platforms are pinned to what runs them, the security boundary is one page, and the
  [1.0 criteria](release-criteria-1.0.md) say what is met and what five things are not.
- A pattern holds across M3 to M6 and is worth stating: **the contract ships before the thing that
  fills it**, in its own change. The shape a number, an edit, or an AI observation travels in is what
  everything downstream depends on, and reviewing it beside a formula, a fix, or a provider makes the
  interesting half the smaller half.
- HTML, live DOM, JSX/TSX, and Figma JSON adapters run the same rules on every surface.
- Surfaces: CLI, SARIF for CI, a Chrome extension shell, and a VS Code extension.
- `@fairux/sdk@0.1.0-beta.3` is published on npm's `next` dist-tag with provenance and
  registry-install smoke evidence.
- The external RulePack taxonomy, authoring kit, and governance boundaries are in place, and a
  Purchase Guard-style external integration is proven against the published registry package:
  [registry consumer smoke run 30550960553](https://github.com/toshtag/fairux-linter/actions/runs/30550960553)
  is green on `main` on both supported Node.js floors.
- The `fairux` CLI is configured for publication but has not been released. Its release contract,
  packed-CLI verification on Linux and Windows, and registry-installed smoke are all implemented;
  publication waits on two owner actions on npmjs.com.
- M2 is complete: `fairux rules`, `fairux explain`, `--rule-pack`, `.fairuxignore`, baselines,
  suppressions, and an HTML report all ship.
- What GitHub code scanning does with FairUX SARIF is measured rather than assumed — see the
  [SARIF upload canary](sarif-upload-canary.md).
- **Every milestone this repository can finish alone is finished.** What is left is five 1.0 criteria,
  and the nearest two are the npmjs.com owner actions M1 recorded — creating the `fairux` package
  name and configuring its Trusted Publisher record. The rest are one SARIF canary dispatch, a
  third-party audit, and a migration guide that is empty until something breaks.
- Two standing boundaries shape everything below: zero findings are never a safety or fairness
  proof, and third-party RulePacks are trusted executable JavaScript, not sandboxed plugins.

## Completed foundation

The foundation phases (P1–P13, P18, P20, P21) built the runtime-agnostic UI model, the
deterministic rule engine and its 13 governed built-in rules, the four adapters, the CLI/SARIF/
Chrome/VS Code surfaces, deterministic and release-safe build output, the fail-closed rule review
and catalog pipeline, and the SDK beta release path with provenance and registry smoke coverage.

P18 closed external consumer integration: `tests/unit/external-consumer-boundary.test.ts` pins
what external products may build, and the registry consumer smoke proves a clean `@fairux/sdk`
install from public npm composing a Purchase Guard-style pack. The detailed history is in Git and in
[status](status.md); progress is no longer tracked by phase numbers.

## M1 — Public CLI beta — repository side complete

Release the `fairux` CLI as a public npm beta, with the same rigor as the SDK beta:

- A CLI release readiness audit before any publish.
- Clean tarball install verification on Node.js 22.18.0 and 24.11.0, on Linux and Windows.
- `fairux --version`, `--help`, and `scan` against HTML and JSX/TSX inputs.
- stdin, file, directory, and glob targets; JSON, Markdown, and SARIF output; config discovery.
- Publish with provenance under the existing publish privilege boundary, on the `next` dist-tag,
  with a GitHub Release.
- A registry-installed CLI smoke, mirroring the SDK's registry consumer smoke.

The readiness audit is done, the release contract it asked for is implemented, and the packed CLI is
now installed and exercised through the executable npm generates for it on Linux and Windows, on
both supported Node.js floors, in both glob separator forms. The registry-installed smoke is
implemented across the same four cells and, like the release contract, has never run green: it
observes a package that does not exist yet, and reports that rather than being skipped. The
[SARIF upload canary](sarif-upload-canary.md) has been run: alert identity survives a line move, a
result that stops being reported becomes `fixed`, and a logical-only DOM or Figma result could not
be uploaded at all — GitHub failed the whole submission. That last one is fixed
([issue #90](https://github.com/toshtag/fairux-linter/issues/90)); the fixed shape has not been
re-measured against code scanning.
Publishing additionally depends
on two owner actions npm requires and this repository cannot perform — creating the `fairux` package
so that a Trusted Publisher record can exist for it, and configuring that record. Both are in the
[CLI beta release runbook](cli-beta-release.md).

[Issue #69](https://github.com/toshtag/fairux-linter/issues/69) (SDK package description) is not
part of this milestone: it is fixed with the next substantive SDK release, whichever comes first.
The published `0.1.0-beta.2` metadata is not rewritten, no release happens for the description
alone, and the issue closes after the corrected registry metadata is verified.

## M2 — Daily linter UX — complete

Features that make the linter livable day to day. Each shipped as its own issue and PR:

| | Item | Issue / PR |
| --- | --- | --- |
| 1 | `fairux rules` — the rule set a scan would run, with effective state | [#93](https://github.com/toshtag/fairux-linter/issues/93) / [#94](https://github.com/toshtag/fairux-linter/pull/94) |
| 2 | `fairux explain <rule-id>` — one rule's governance record | [#95](https://github.com/toshtag/fairux-linter/issues/95) / [#96](https://github.com/toshtag/fairux-linter/pull/96) |
| 3 | `--rule-pack` — explicit external RulePack loading | [#97](https://github.com/toshtag/fairux-linter/issues/97) / [#98](https://github.com/toshtag/fairux-linter/pull/98) |
| 4 | `.fairuxignore` path exclusion | [#99](https://github.com/toshtag/fairux-linter/issues/99) / [#100](https://github.com/toshtag/fairux-linter/pull/100) |
| 5 | Baselines | [#101](https://github.com/toshtag/fairux-linter/issues/101) / [#102](https://github.com/toshtag/fairux-linter/pull/102) |
| 6 | Suppressions with a required reason | [#103](https://github.com/toshtag/fairux-linter/issues/103) / [#105](https://github.com/toshtag/fairux-linter/pull/105) |
| 7 | HTML report output | [#106](https://github.com/toshtag/fairux-linter/issues/106) / [#107](https://github.com/toshtag/fairux-linter/pull/107) |

One boundary held throughout and carries into M3: **none of these reports coverage.** `fairux rules`
lists enabled rules and says in as many words that enabled is not coverage; the HTML report has no
scores; an empty report states that no findings is not a statement that a page is fair. What a scan
actually checked is M3's subject, and until it exists nothing pretends to answer it.

One follow-up is open rather than done:
[issue #104](https://github.com/toshtag/fairux-linter/issues/104), inline suppression comments. It is
not a CLI change — the HTML and AST adapters discard comments, and associating one with the node on
the following line needs position information carried into the model every rule sees.

Optional coding-agent integrations may be evaluated after the public CLI beta. They must be
separately installable and must not auto-load merely because a contributor cloned this repository.

## M3 — Capability and coverage — complete

Make the report say what was actually checked, before any scoring exists. Each item shipped as its
own issue and PR:

| | Item | Issue / PR |
| --- | --- | --- |
| 1 | Capability vocabulary, per-scan coverage, and capability gating | [#114](https://github.com/toshtag/fairux-linter/issues/114) / [#115](https://github.com/toshtag/fairux-linter/pull/115) |
| 2 | Coverage in Markdown, HTML, SARIF, and `fairux rules` | [#116](https://github.com/toshtag/fairux-linter/issues/116) / [#117](https://github.com/toshtag/fairux-linter/pull/117) |
| 3 | Live visual facts (`computed-style`, `viewport`) | [#118](https://github.com/toshtag/fairux-linter/issues/118) / [#119](https://github.com/toshtag/fairux-linter/pull/119) |
| 4 | An evaluation corpus, measured and checked in CI | [#120](https://github.com/toshtag/fairux-linter/issues/120) / [#122](https://github.com/toshtag/fairux-linter/pull/122) |
| 5 | Form behaviour (`form`) | [#123](https://github.com/toshtag/fairux-linter/issues/123) / [#124](https://github.com/toshtag/fairux-linter/pull/124) |
| 6 | The journey contract (`journey`) | [#125](https://github.com/toshtag/fairux-linter/issues/125) / [#128](https://github.com/toshtag/fairux-linter/pull/128) |

This milestone precedes the Risk Index because a score without coverage is misleading. Coverage is
deliberately not a score: counts and lists, no ratio, no grade, and the boundary printed beside them.

**Three things it deliberately did not do**, each carried forward rather than quietly dropped:

- **No rule spends the new capabilities.** Every built-in rule's review record sits under a
  maintainer-approved fingerprint, so changing what a rule detects needs a rule-version bump, an
  updated review record, and a fresh maintainer approval. `computed-style`, `viewport`, `form`, and
  `journey` are supplied and unspent. The corpus's one recorded miss
  ([issue #121](https://github.com/toshtag/fairux-linter/issues/121)) waited on the same gate and went
  through it: `obstruction/confirmshaming@1.1.0` is the shape a rule change takes here.
- **`network` is not implemented, and now it is decided rather than pending.** The four questions M3
  said had to be settled first are settled in
  [the security boundary](security-boundary.md#the-network-capability-and-why-it-stays-unavailable)
  ([#126](https://github.com/toshtag/fairux-linter/issues/126)): the extension permission it would
  need is **refused**, not because comprehensive observation is impossible but because the permission,
  the data it collects, and the privacy model that comes with it do not fit a tool that touches a page
  only when you click on it. Resource timing — the API that looks like it would do the
  job — still cannot explain redirects, cache hits, cross-origin iframes, service workers, request
  bodies, or initiator attribution, so every scan reporting `network` as unavailable is the accurate
  answer and not a placeholder.
- **The CLI journey command followed later**, and it did
  ([#127](https://github.com/toshtag/fairux-linter/issues/127)): `fairux scan-journey <file>` takes
  an explicit journey file, never an implicit addition to `scan`'s arguments, and never launches a
  browser. JSON and Markdown render it; SARIF and HTML are refused with their own reasons, and
  `--fail-on` reads both layers because a threshold that read one would pass half the flows it was
  meant to catch. `fairux rules` lists journey rules separately and leaves them out of the count a
  scan's rules are in.

## M4 — FairUX Risk Index — complete

A higher-is-worse risk index with a versioned formula, always reported
beside its coverage. An insufficient-coverage state is explicit, zero findings are never presented as
safety, and the formula is calibrated against the evaluation corpus.

The **contract** is implemented ([#129](https://github.com/toshtag/fairux-linter/issues/129)): three
states of which only one carries a number, no provisional score on any unscored path, coverage and
confidence as separate fields, versions that cannot drift, deterministic output, and one shared view
so no surface can print a number the report does not carry. `computeRiskIndex` in `@fairux/core` returns
`unsupported` on its own, because the model is policy and lives beside the rules.

The **first model**, `fairux-risk/1`, followed as its own change
([#131](https://github.com/toshtag/fairux-linter/issues/131)): severity weights damped by confidence,
the worst single input, capped at 100, with every constant argued for in
[the model document](risk-index-model.md) and its behaviour measured in
[the calibration](generated/risk-index-calibration.md). Shipping the formula in the same change as
the shape it travels in would have made the number the reviewable thing and the boundary an
afterthought.

Rendering followed ([#136](https://github.com/toshtag/fairux-linter/issues/136)):
`fairux scan --risk-index <file>` writes it beside a scan, never to stdout, and the HTML report shows
a panel. The exit code is unchanged and proven so — a build goes red because of what was found, never
because a number crossed a line. Grade language and threshold-based CI failure are refused rather
than pending.

`fairux-risk/1` was approved as an explicitly versioned first baseline, not as evidence that its
constants are optimal — the calibration discloses that the severity ratios are not load-bearing on
the current corpus and the confidence floor is. A changed formula or constant is a new model version,
never a quiet edit to this one, and
[`fairux-risk/2`](risk-index-model.md#fairux-risk2) is what that rule looks like when it is followed:
the same weights, an aggregation that can see breadth, calibrated over corpus collections that
contain multi-page inputs, and **not the default**
([#134](https://github.com/toshtag/fairux-linter/issues/134)).

One follow-up stays open. A corpus this project did not write
([#133](https://github.com/toshtag/fairux-linter/issues/133)) — every page and now every grouping is
still one written here, though seven of them are now written to be **hard**, and three of those found
false positives on their first run ([#161](https://github.com/toshtag/fairux-linter/issues/161),
[#162](https://github.com/toshtag/fairux-linter/issues/162)). Writing a page your own rules struggle
with is a better test than writing an easy one, and it is still not a page somebody else wrote. How a journey should score
([#135](https://github.com/toshtag/fairux-linter/issues/135)) is answered: a cross-step finding
weighs like a page finding, a flow is gated like a page, and **anchoring decides the number** — the
same finding is worth 10 on the worst step and nothing at all on a quiet one. `stepId` is where a
reader should look and the aggregation reads it as which input the finding belongs to, which is one
field answering two questions. Measured with a probe rule that ships nowhere, because the built-in
rule set has none. Neither model changes: a journey finding forming its own pool is a different
aggregation, and that is a different `modelVersion`.

## M5 — Safe remediation — complete

A remediation schema that separates safe from review-required fixes: dry-run first, checksums and
conflict detection, and a safe-only write. AI-generated edits are never auto-applied, and no
`--unsafe` escape hatch is added.

The **schema** ([#139](https://github.com/toshtag/fairux-linter/issues/139)) puts safety and origin
in the data with a rationale required for both levels, a file checksum, and edits that each carry the
text they expect to replace. An `ai`-origin remediation cannot be `safe`, enforced in validation — the
promise about AI-generated edits was a rule before M6 existed to constrain.

**Applying** ([#141](https://github.com/toshtag/fairux-linter/issues/141)) is a pure function with six
refusals and an all-or-nothing rule, driven by `--fix-dry-run` and `--fix-write` sharing one plan.
The applying flag is not `--write`: beside the existing `--write-baseline`, two names promising the
same thing would have been worse than a longer one. No flag applies a `review-required` remediation,
and neither flag changes stdout or the exit code.

No built-in rule proposes a fix, and now only one thing stops one:
a rule change needs a maintainer review. The other gate is gone
([#142](https://github.com/toshtag/fairux-linter/issues/142)) — the model carries a range per
attribute when an adapter is asked for one, so a browser-safe rule can build a precise edit without
the filesystem an external pack falls back on. It is requested rather than assumed, because it costs
about 1.7× the serialized model on an attribute-heavy page; the CLI asks for it on every scan, so no
fix flag can change which rules run. JSX/TSX is the one adapter where the question is open rather
than answered: an attribute value there may be an expression, and removing a binding is not the same
edit as removing an attribute.

## M6 — Optional AI augmentation — contract implemented, no provider

**The current milestone.** Provider-neutral, opt-in, and non-blocking: AI output stays separate from
deterministic findings, with redaction, provenance, timeouts, and evaluation. AI may assist
candidate-rule discovery, but an AI-only signal never becomes a blocking finding.

The **contract** is implemented ([#144](https://github.com/toshtag/fairux-linter/issues/144)): an
observation that cannot become a finding, cannot fail a build, and cannot carry anything to a provider
that was not on an allowlist — with a timeout that lets a provider fail without taking the scan with
it. Nothing sends anything anywhere, and the engine stays deterministic and AI-free.

What remains: a provider, the configuration that selects one, and the evaluation that would say
whether its output is worth reading. Each is a decision about sending page content to a third party,
which is why the boundaries landed first.

## M7 — Stable SDK and CLI — repository side complete

The path to 1.0: a public API inventory, schema compatibility guarantees, a
deprecation policy, a migration guide, registry canaries, documented supported platforms, an explicit
security boundary, and written 1.0 release criteria.

**Supported platforms**, the **security boundary**, and the **1.0 release criteria** are written and
checked where checking is possible ([#151](https://github.com/toshtag/fairux-linter/issues/151)): the
Node floors are asserted to agree across every manifest, every CI matrix, and the document; the
boundary states what is trusted as well as what is not, and admits there has been no third-party
review; and every criterion is either met with evidence that exists or open with what it needs.
Registry canaries were already running and are recorded rather than rebuilt.

Five criteria remain open. Two of them — publishing the CLI, and the registry smoke that cannot run
until it is published — are the same owner actions on npmjs.com that M1 recorded, and no amount of
repository work moves them. The corpus's detection gap was the sixth, and it closed the way it had to:
a rule version bump, an updated review record, and a fresh maintainer approval.

The **compatibility guarantees and deprecation policy** are written and partly checked
([#149](https://github.com/toshtag/fairux-linter/issues/149)): what is public, what additive and
breaking mean, which version moves for each, and the rule that nothing is removed without being
deprecated first — with the inventory recording deprecation so a removal can be judged.

The **API inventory** is implemented ([#147](https://github.com/toshtag/fairux-linter/issues/147)):
every export of every published entry point, generated from the built declarations and checked in CI,
with a removal failing the check and an addition arriving as a diff. It is the measurement the
compatibility guarantees and the deprecation policy will need, and it exists before either of them
because both are decisions and this is not.
