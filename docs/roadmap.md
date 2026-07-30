# FairUX roadmap

This is the product roadmap: the implementation order and the dependencies between milestones.
It is not a task ledger — current implementation state lives in [status](status.md), concrete
work items live in GitHub Issues, and durable design decisions live in
[`design/decisions/`](../design/decisions/).

## Current position

- The deterministic engine and the built-in FairUX rule pack are implemented, with governance
  metadata generated from maintainer-approved review records.
- HTML, live DOM, JSX/TSX, and Figma JSON adapters run the same rules on every surface.
- Surfaces: CLI, SARIF for CI, a Chrome extension shell, and a VS Code extension.
- `@fairux/sdk@0.1.0-beta.2` is published on npm's `next` dist-tag with provenance and
  registry-install smoke evidence.
- The external RulePack taxonomy, authoring kit, and governance boundaries are in place, and a
  Purchase Guard-style external integration is proven against the published registry package:
  [registry consumer smoke run 30550960553](https://github.com/toshtag/fairux-linter/actions/runs/30550960553)
  is green on `main` on both supported Node.js floors.
- The `fairux` CLI is configured for publication but has not been released.
- Two standing boundaries shape everything below: zero findings are never a safety or fairness
  proof, and third-party RulePacks are trusted executable JavaScript, not sandboxed plugins.

## Completed foundation

The foundation phases (P1–P13, P18, P20, P21) built the runtime-agnostic UI model, the
deterministic rule engine and its 13 governed built-in rules, the four adapters, the CLI/SARIF/
Chrome/VS Code surfaces, deterministic and release-safe build output, the fail-closed rule review
and catalog pipeline, and the SDK beta release path with provenance and registry smoke coverage.

P18 closed external consumer integration: the Purchase Guard architecture contract
([ADR](../design/decisions/P18-T1-purchase-guard-architecture-contract.md)) pins what external
products may build, and the registry consumer smoke proves a clean `@fairux/sdk` install from
public npm composing a Purchase Guard-style pack. The detailed history is in Git and in
[status](status.md); progress is no longer tracked by phase numbers.

## M1 — Public CLI beta

The next milestone. Release the `fairux` CLI as a public npm beta, with the same rigor as the SDK
beta:

- A CLI release readiness audit before any publish.
- Clean tarball install verification on Node.js 22.18.0 and 24.11.0, on Linux and Windows.
- `fairux --version`, `--help`, and `scan` against HTML and JSX/TSX inputs.
- stdin, file, directory, and glob targets; JSON, Markdown, and SARIF output; config discovery.
- Publish with provenance under the existing publish privilege boundary, on the `next` dist-tag,
  with a GitHub Release.
- A registry-installed CLI smoke, mirroring the SDK's registry consumer smoke.

[Issue #69](https://github.com/toshtag/fairux-linter/issues/69) (SDK package description) is not
part of this milestone: it is fixed with the next substantive SDK release, whichever comes first.
The published `0.1.0-beta.2` metadata is not rewritten, no release happens for the description
alone, and the issue closes after the corrected registry metadata is verified.

## M2 — Daily linter UX

Features that make the linter livable day to day, each as its own issue and PR, in order:

1. `fairux rules` — list the active rule set.
2. `fairux explain <rule-id>` — explain one rule.
3. Explicit external RulePack loading from the CLI.
4. `.fairuxignore` path exclusion.
5. Baselines for adopting the linter on an existing codebase.
6. Suppressions with a recorded reason.
7. An HTML report output.

Baselines, suppressions, and ignores are separate PRs, not one.

## M3 — Capability and coverage

Make the report say what was actually checked, before any scoring exists:

- A capability vocabulary, with required and optional capabilities per rule.
- Available vs. unavailable capabilities per scan, and eligible vs. executed vs. skipped rules
  with a skip reason.
- New detection capabilities: live visual facts, journey, form, and network signals.
- An evaluation corpus to measure detection quality against.

This milestone precedes the Risk Index because a score without coverage is misleading.

## M4 — FairUX Risk Index

A higher-is-worse risk index with a versioned formula, always reported beside its coverage. An
insufficient-coverage state is explicit, zero findings are never presented as safety, and the
formula is calibrated against the evaluation corpus. Surfaces in JSON, Markdown, SARIF, and the
HTML report.

## M5 — Safe remediation

A remediation schema that separates safe from review-required fixes: dry-run first, checksums and
conflict detection, and a safe-only `--write`. AI-generated edits are never auto-applied, and no
`--unsafe` escape hatch is added.

## M6 — Optional AI augmentation

Provider-neutral, opt-in, and non-blocking: AI output stays separate from deterministic findings,
with redaction, provenance, timeouts, and evaluation. AI may assist candidate-rule discovery, but
an AI-only signal never becomes a blocking finding.

## M7 — Stable SDK and CLI

The path to 1.0: a public API inventory, schema compatibility guarantees, a deprecation policy, a
migration guide, registry canaries, documented supported platforms, an explicit security
boundary, and written 1.0 release criteria.
