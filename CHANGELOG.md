# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/), and the project aims to follow
[Semantic Versioning](https://semver.org/) once packages are published.

## [Unreleased]

First public release in preparation. Highlights of what exists today:

### Security
- **Config auto-discovery no longer executes untrusted code.** Previously, scanning a directory
  auto-discovered and ran `fairux.config.{ts,mjs,js,cjs}` via `jiti`, so a config shipped in an
  untrusted repo/PR could execute arbitrary code with the scanning user's (or CI runner's)
  privileges. Now:
  - Auto-discovery loads **only `fairux.config.json`** (data, never executed); an executable config
    seen during discovery is reported (warning) instead of running — even when a JSON is adopted
    elsewhere.
  - Executable config runs **only via an explicit `--config <path>`**, with a stderr trust warning
    printed before import.
  - Discovery is bounded by a purely lexical search to the repo root (nearest `.git`) / nearest
    `package.json` / start dir, so it finds a monorepo's root config but never reaches unrelated
    parents. Auto-discovered JSON must be a regular, non-symlink file (a symlink — **including a
    dangling one** — is refused, never treated as absent) under a 1 MiB cap. A nearest config that
    exists but fails these checks is a **fail-closed error**, not a silent fallthrough.
  - The vetted bytes are read during discovery and parsed as-is, so the CLI parses exactly what
    discovery vetted (the path is not re-opened). The scan target is resolved once and the same
    resolved path is used for discovery and the read, so a `symlink/../file` input can't make
    discovery vet one path while the read opens another.
  - JSON config is parsed defensively: `__proto__` / `constructor` / `prototype` keys are rejected
    at any depth. An explicit `--config` may be a symlink (user-named) but must be a regular file
    under a cap (a FIFO can't hang the scan, a huge file can't OOM it).
  - Warning/error paths strip C0/C1 control chars and Unicode bidi controls from user-derived paths;
    a non-`Error` throw from an executable config no longer crashes the error reporter.
  - **Not in scope:** FairUX does not sandbox the scan target — confining it to a repo, or rejecting
    a target reached via an ancestor symlink / hard link / mount / Windows junction, is the caller's
    responsibility. Scanned-document size/depth limits are tracked separately (P10-T9).
  - **Behavior change:** an existing `fairux.config.ts` (etc.) relied on for auto-discovery is no
    longer loaded automatically — pass `--config` or convert it to `fairux.config.json`.

### Added
- **Engine** (`@fairux/core`): runtime-agnostic, browser-safe `scan()` pipeline, document model,
  stable finding fingerprints, NFKC text normalization.
- **RulePack taxonomy**: external RulePacks can declare namespaced categories and page contexts via
  `RulePack.taxonomy`. Built-in category strings remain valid, while external categories such as
  `purchase-guard/return-policy` must be declared before rules use them. `composeRulePacks()` and
  scanners expose the validated taxonomy metadata, and HTML/DOM SDK scans can supply declared
  external page-context signals per input.
- **RulePack authoring kit**: external authoring guide, testing guide, taxonomy beta migration
  notes, copyable example package, and valid/invalid RulePack fixtures for SDK authors.
- **Rule governance contract ADR**: the pre-publication RuleMeta governance contract now defines
  provider-neutral capability vocabulary, optional capabilities, non-empty metadata arrays,
  canonical jurisdiction IDs, structured official-source identity versus review metadata,
  pack-local deprecation replacement validation, deprecated rule pack eligibility, frozen ISO
  country-code set policy, and the private `@fairux/core` versus public `@fairux/sdk` package
  boundary.
- **Rule governance metadata**: `RuleMeta` now carries public maturity, capability,
  evidence-requirement, jurisdiction, official-source, limitation, and deprecation metadata through
  `@fairux/core` and the public `@fairux/sdk` type mirror. RulePack composition validates the
  governance contract before experimental-pack exclusion, snapshots the metadata immutably, and
  exposes additive SARIF rule metadata under `tool.driver.rules[].properties.fairux`.
- **SDK governance smoke coverage**: packed and registry SDK consumer smoke tests now compile the
  negative non-empty tuple fixture against emitted SDK declarations and exercise full governance
  metadata preservation, deep freeze, mutation isolation, and invalid governance rejection.
- **Built-in rule review foundation**: `@fairux/rules` now carries a machine-readable
  official-source identity catalog and 13 prepared built-in rule review records. The
  `rules:reviews:check` script validates source identity separation, prepared status boundaries,
  corpus evidence classes, locale/runtime/false-positive/evidence/performance/determinism notes,
  and the stable/experimental rule count before governance metadata migration.
- **Built-in review foundation hardening**: review records and official sources now use schema v2
  with rule-version provenance, rule-specific source mappings, executable corpus references,
  uncovered scenario separation, fail-closed validation, and current versus vacated source status
  tracking for the FTC Negative Option materials.
- **Built-in review contract parity**: review validation now shares the core jurisdiction and
  SemVer contracts, rejects `UK` jurisdiction aliases in favor of `GB`, validates source-specific
  mapping notes, `supportKind`, `sourceLocator`, and strict review exception schemas, and keeps
  official-source mappings prepared rather than maintainer-approved.
- **Built-in review provenance closure**: review validation now enforces publication-status and
  `supportKind` compatibility, requires non-current source status notes, rejects template mapping
  notes and generic-only locators, records the 2026 FTC Negative Option ANPRM as proposed rather
  than current authority, and narrows current 16 CFR Part 425 mappings to contextual support for
  prenotification negative option plans.
- **Built-in review data accuracy**: EDPB consent mappings now carry EU and EEA jurisdictions,
  visual-imbalance support distinguishes genuine-choice context from direct prominence guidance,
  FTC consent locators point to the concrete dark-pattern examples, and scarcity limitations state
  that FairUX does not determine whether limited-time claims are true.
- **Built-in governance catalog migration**: built-in rules now import generated review governance
  from the prepared review records, including maturity, jurisdictions, current runtime official
  sources, and known limitations. The deterministic generated rule catalog records full
  official-source review provenance while keeping vacated, historical, and proposed source records
  out of runtime `officialSources`.
- **SDK release automation**: `@fairux/sdk` has a separate `sdk-v*` Trusted Publishing workflow,
  exact-tarball SHA-256 verification, release preflight script, artifact upload, provenance publish
  command, and SDK GitHub Release path. Actual npm publication still requires owner approval and
  registry-installed verification.
- **Rules** (`@fairux/rules`): 13 explainable rules (11 enabled + 2 experimental) across consent,
  subscription, cancellation, scarcity, hidden-cost, and obstruction — English + Japanese.
- **Adapters**: static HTML (`@fairux/html`), live DOM (`@fairux/dom`), JSX/TSX (`@fairux/ast`).
- **Reporters** (`@fairux/report`): JSON (stable `FairUxReport` envelope), Markdown, SARIF 2.1.0.
- **CLI** (`@fairux/cli`): `fairux scan <path>` with adapter selection by extension; `fairux.config.*`
  for enabling/disabling rules and overriding severity.
- **Surfaces**: a Manifest V3 browser-extension shell and a VS Code extension (Problems-panel
  diagnostics for HTML + JSX/TSX).
- **Docs**: report-schema reference and a GitHub Actions / SARIF guide.

### Notes
- The `FairUxReport` JSON output is treated as a public API.
- Findings are UX **risk signals**, not legal judgments.
- Migration note for external RulePack authors: use built-in categories unchanged, or add
  `taxonomy.categories` for every namespaced external category. Category parents may target a
  built-in category or a category declared in the same RulePack only. Scoped npm-style pack IDs such
  as `@purchase-guard/jp-commerce` own the `purchase-guard/...` taxonomy namespace.
- Rule governance migration note for external RulePack authors: rules need maturity, non-empty
  required capabilities, non-empty evidence requirements, canonical jurisdiction/source metadata
  when present, and deprecation metadata where applicable. Capability IDs describe observation
  contracts rather than provider instances, built-in semantics use built-in IDs, official-source
  review metadata is rule-specific, same source IDs across different RulePacks are not composition
  conflicts, deprecated rules may remain in stable or experimental packs while preserving their
  previous runtime gate, and deprecation replacements stay inside the same source RulePack until a
  dependency contract exists. This is a source-breaking beta contract migration, tracked in
  `docs/migrations/rule-governance-beta.1.md`.
- `RulePack.taxonomy` remains optional authoring metadata. `composeRulePacks().taxonomy` and scanner
  `taxonomy` are validated output snapshots with required `categories` and `pageContexts` arrays.
- Locale inputs use deterministic RFC 5646 syntax validation for BCP 47 tags, including extension,
  private-use, and grandfathered tags. This validation is syntactic only and does not imply locale
  dictionary coverage. Duplicate variants are rejected case-insensitively, duplicate extension
  singletons are rejected, and IANA registry membership plus extlang prefix relationships are not
  validated.
- Roadmap traceability: local tarball clean-consumer proof is tracked under P20 release readiness;
  P18 is reserved for post-beta external consumer boundary and registry-installed proof.
