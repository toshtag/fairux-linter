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
- HTML, live DOM, JSX/TSX, and Figma JSON adapters run the same rules on every surface.
- Surfaces: CLI, SARIF for CI, a Chrome extension shell, and a VS Code extension.
- `@fairux/sdk@0.1.0-beta.2` is published on npm's `next` dist-tag with provenance and
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
  `journey` are supplied and unspent; the corpus's one recorded miss
  ([issue #121](https://github.com/toshtag/fairux-linter/issues/121)) waits on the same gate.
- **`network` is not implemented.** Resource timing alone cannot explain redirects, cache hits,
  iframes, service workers, request bodies, or initiator attribution, and the extension permission,
  privacy, schema, and Purchase Guard boundary questions are decided before it is built —
  [issue #126](https://github.com/toshtag/fairux-linter/issues/126).
- **No CLI journey command.** The contract landed first; the CLI takes an explicit journey file, not
  an implicit addition to `scan`'s arguments, and never launches a browser —
  [issue #127](https://github.com/toshtag/fairux-linter/issues/127).

## M4 — FairUX Risk Index — complete

**The current milestone.** A higher-is-worse risk index with a versioned formula, always reported
beside its coverage. An insufficient-coverage state is explicit, zero findings are never presented as
safety, and the formula is calibrated against the evaluation corpus.

The **contract** is implemented ([#129](https://github.com/toshtag/fairux-linter/issues/129)): three
states of which only one carries a number, no provisional score on any unscored path, coverage and
confidence as separate fields, versions that cannot drift, deterministic output, and one shared view
so no surface can print a number the report does not carry. `computeRiskIndex` returns `unsupported`
today, because **no model ships**.

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
the current corpus and the confidence floor is. Three follow-ups carry that forward without touching
it: a corpus this project did not write
([#133](https://github.com/toshtag/fairux-linter/issues/133)), an aggregation that can see breadth
([#134](https://github.com/toshtag/fairux-linter/issues/134)), and how a journey should score
([#135](https://github.com/toshtag/fairux-linter/issues/135)). A changed formula or constant is a new
model version, never a quiet edit to this one.

## M5 — Safe remediation

**The next milestone.** A remediation schema that separates safe from review-required fixes: dry-run
first, checksums and conflict detection, and a safe-only `--write`. AI-generated edits are never auto-applied, and no
`--unsafe` escape hatch is added.

## M6 — Optional AI augmentation

Provider-neutral, opt-in, and non-blocking: AI output stays separate from deterministic findings,
with redaction, provenance, timeouts, and evaluation. AI may assist candidate-rule discovery, but
an AI-only signal never becomes a blocking finding.

## M7 — Stable SDK and CLI

The path to 1.0: a public API inventory, schema compatibility guarantees, a deprecation policy, a
migration guide, registry canaries, documented supported platforms, an explicit security
boundary, and written 1.0 release criteria.
