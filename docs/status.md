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
  metadata are implemented. Official-source cataloging and full built-in review closeout remain
  planned.
- The SDK tarball and registry consumer smoke path compiles the negative public governance
  TypeScript fixture against emitted declarations and exercises the full governance metadata
  contract, including nested freeze, mutation isolation, and invalid governance rejection.
- Built-in rule review foundation now has a schema-v2 machine-readable official-source identity
  catalog and 13 prepared review records. Source identity is separated from catalog metadata and
  rule-specific source review mappings. The records carry rule version provenance, rule
  jurisdictions, executable positive and negative corpus evidence, uncovered scenarios, locale,
  runtime, false-positive, evidence usefulness, performance, determinism, and non-empty limitation
  notes. The fail-closed `pnpm rules:reviews:check` validator reads built runtime metadata, checks
  version parity and corpus test references, and does not treat prepared records as maintainer
  approvals.
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
- Built-in rule metadata migration from prepared review records, deterministic generated rule
  catalog, and final maintainer review closeout.
- `fairux rules`, `fairux explain`, baselines, ignores, and suppressions.
- Coverage-aware risk index and report coverage metadata.
- Safe remediation schema, `--fix-dry-run`, and safe-only `--write`.
- Journey, network, form, and live visual detection capabilities.
- Provider-neutral AI augmentation, redaction, provenance, and evaluation workflow.
- A sandbox boundary for scanning untrusted file trees.

## Planned phase order

The roadmap keeps the deterministic FairUX core separate from external consumer products:

1. P13 taxonomy and rule governance, continuing with built-in official-source cataloging and review
   closeout after the public RuleMeta implementation.
2. P20 SDK beta release readiness, including local tarball clean-consumer proof before publish and
   registry verification during release. See [SDK beta release runbook](sdk-beta-release.md).
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
