# FairUX status

This document is the source of truth for what is implemented, publish-ready, and unpublished. The
implementation order ahead lives in the [roadmap](roadmap.md). It intentionally avoids treating
"no findings" as proof that a page is fair, legal, or safe.

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
- Local browser execution without network or AI dependencies in the FairUX core.

## Published beta

### SDK publication state

| Package version | npm state |
| --- | --- |
| `@fairux/sdk@0.1.0-beta.2` | **published** |

This table is the machine-checked record. `pnpm release:check:sdk` reads exactly one row from it and
requires the package and version to equal the SDK manifest's, so the prose below cannot drift away
from the version being released. The prose that follows explains the row; it does not establish it.

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
- One release-scoped follow-up stays open rather than being fixed here.
  [Issue #69](https://github.com/toshtag/fairux-linter/issues/69) narrows the SDK package
  description; `0.1.0-beta.2` is already published, so changing the manifest alone would leave the
  source disagreeing with the registry metadata for the same version. It is resolved at the next
  published SDK version, with the bump.
- `fairux@0.1.0-beta.1` is configured as a CLI package, but public registry availability still
  depends on the beta publishing workflow and release verification.
- The CLI's repository-side release contract is implemented and **not yet executed**: the tag and
  manifest gates, a source-map policy the packed tarball is audited against, an idempotent
  publication plan (absent → publish, matching digest → skip, conflicting digest → fail),
  post-publish digest and dist-tag verification, generated release notes, and a create-or-repair
  GitHub Release. `pnpm release:check:cli` and `pnpm release:dry-run:cli` rehearse the whole path
  with no registry and no tag, and CI runs the dry run on both Node.js floors.
- The packed CLI is verified on both platforms it declares support for. `pack-smoke` on
  `ubuntu-latest` and `pack-smoke-windows` on `windows-latest` each run `pnpm pack:smoke` on
  Node.js 22.18.0 and 24.11.0: pack, audit the archive, install into a clean project, and run the
  published CLI's behaviour contract through the executable npm generated — `fairux.cmd` on
  Windows, not `node dist/index.js`. Both platforms run the same archive audit and the same
  installed-CLI contract, which covers identity, the HTML/JSX/TSX adapters, stdin/file/directory/
  glob targets, Markdown/JSON/SARIF output, config auto-discovery, an explicit trusted config, and
  exit codes 0/1/2; report and SARIF paths are asserted to carry no drive letter, backslash, or
  absolute temporary directory, so a Windows run cannot change a published identity. Reaching that
  required the audit to stop depending on `sha256sum`, `sh`, and an external `tar`, which is why
  the archive is now read with Node built-ins. The installed-CLI contract takes an
  already-installed CLI, so the registry-installed smoke can reuse it unchanged.
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

- Explicit CLI loading for external RulePacks.
- `fairux rules`, `fairux explain`, baselines, ignores, and suppressions.
- Coverage-aware risk index and report coverage metadata.
- Safe remediation schema, `--fix-dry-run`, and safe-only `--write`.
- Journey, network, form, and live visual detection capabilities.
- Provider-neutral AI augmentation, redaction, provenance, and evaluation workflow.
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
