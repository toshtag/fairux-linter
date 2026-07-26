# FairUX status

This document is the source of truth for what is implemented, publish-ready, unpublished, and
planned. It intentionally avoids treating "no findings" as proof that a page is fair, legal, or
safe.

## Implemented in this repository

- Runtime-agnostic normalized UI model.
- Deterministic rule engine with the built-in FairUX rule pack.
- HTML, DOM, AST/JSX, and Figma JSON adapters.
- CLI, GitHub Actions/SARIF output, Chrome extension, and VS Code extension surfaces.
- JSON, Markdown, and SARIF report output.
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
  records are `maintainer-approved`; the 2 experimental records were reviewed and deliberately kept
  `prepared`, `experimental`, and default-off. 13 uncovered scenarios are acknowledged as known,
  non-exhaustive coverage boundaries, and there are no approved open review exceptions. The decision
  is recorded in the [P13 maintainer review packet](reviews/P13-built-in-rule-maintainer-review.md)
  with the approval target commit, comment URL, approver, and date, and is checked in as machine-
  readable evidence in `packages/rules/reviews/maintainer-approval.json`. CI runs
  `pnpm rules:reviews:check:approved`, which re-verifies that evidence against the packet on every
  run, so adding a stable built-in rule without approval fails CI. The approval changed no detection
  behavior: the substantive review fingerprint and the generated runtime governance module are both
  unchanged by it.
- Build output is deterministic and release-safe. TypeScript configuration is split into a
  typecheck contract (`tsconfig.json`, `noEmit`) and a per-package declaration-emit contract
  (`tsconfig.build.json`, scoped to `src`), so a build cannot write into a source tree. The
  fail-closed `pnpm check:build-output` asserts that no artifact lands outside the `dist/` of a
  workspace discovered from its manifest — a directory merely named `dist`, or one under a
  workspace that does not exist, does not qualify — that hand-written `.mjs`/`.d.mts` files are
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
- Local browser execution without network or AI dependencies in the FairUX core.

## Publish-ready preview, not released to npm

- `@fairux/sdk@0.1.0-beta.1` is configured as a public package and covered by pack smoke tests, but
  it has not been published to npm. SDK release automation is prepared separately from the CLI path
  in `.github/workflows/publish-sdk.yml`; owner approval, npm Trusted Publisher setup, tag push, and
  registry-installed smoke evidence are still required. The release path is beta-only, rerunnable
  after matching partial npm publication, and source-map publication is disabled for the SDK beta.
- `fairux@0.1.0-beta.1` is configured as a CLI package, but public registry availability still
  depends on the beta publishing workflow and release verification.
- Until the first npm release is complete, external products should consume this repository only as
  a workspace/link or from the controlled local tarball smoke test tracked under P20 release
  readiness. Internal monorepo packages are not public compatibility contracts.

## Not implemented yet

- Public npm beta release with provenance, GitHub Release notes, and clean registry install checks.
- Explicit CLI loading for external RulePacks.
- `fairux rules`, `fairux explain`, baselines, ignores, and suppressions.
- Coverage-aware risk index and report coverage metadata.
- Safe remediation schema, `--fix-dry-run`, and safe-only `--write`.
- Journey, network, form, and live visual detection capabilities.
- Provider-neutral AI augmentation, redaction, provenance, and evaluation workflow.
- A sandbox boundary for scanning untrusted file trees.

## Planned phase order

The roadmap keeps the deterministic FairUX core separate from external consumer products:

1. P13 taxonomy and rule governance is complete, through the built-in governance catalog migration
   and explicit maintainer review approval and closeout.
2. P20 SDK beta release readiness is next, including local tarball clean-consumer proof before
   publish and registry verification during release. See
   [SDK beta release runbook](sdk-beta-release.md).
   [Issue #57](https://github.com/toshtag/fairux-linter/issues/57) no longer blocks release
   execution: `pnpm build` leaves the worktree clean, `pnpm lint` succeeds after a build, two
   consecutive builds are byte-identical, and declarations are emitted only under each package
   `dist/`. What remains is owner-side — npm Trusted Publisher setup, release approval, tag push,
   and registry-installed verification.
3. P18 external consumer integration proof after the beta release, including a Purchase Guard-style
   rule pack outside FairUX product boundaries and registry-installed proof without local tarballs.
4. P14 linter UX, baselines, ignores, and suppressions.
5. P15 capability expansion for journey, form, network, and live visual facts.
6. P16 coverage-aware risk index.
7. P17 safe remediation.
8. P19 optional AI augmentation.

## Product boundary

FairUX returns deterministic UX risk signals: findings, evidence, severity, confidence, rule
metadata, and limitations. It does not return legal verdicts, fraud verdicts, site safety verdicts,
or proof that a UI is fair.

Purchase Guard-style products are separate applications. They may reuse the FairUX SDK and
RulePack contract, but URL, TLS, domain, redirect, reputation, and other site/security signals
belong in their own namespace at the application layer, not inside FairUX findings.
