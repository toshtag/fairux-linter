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

### Fixed
- **npm Trusted Publishing could not authenticate.** The SDK's first release attempt
  ([run 30233771956](https://github.com/toshtag/fairux-linter/actions/runs/30233771956)) packed,
  smoke-tested, audited, and signed provenance for a tarball, then got `E404` on the registry
  `PUT`; nothing was published. The failure matches the known `actions/setup-node` placeholder mode.
  The `0.1.0-beta.2` attempt confirmed that half — the publish job reported `npm config files: none
  present`, so npm held no credential to misuse — but did not publish either. The mechanism: `actions/setup-node` had
  been given `registry-url`, which writes
  `//registry.npmjs.org/:_authToken=${NODE_AUTH_TOKEN}` into the job's npm user config — and since
  Trusted Publishing sets no token, npm saw an unresolvable credential rather than none and never
  entered the OIDC exchange. Provenance signing succeeding proved nothing: `--provenance` signs
  with the GitHub OIDC token directly, separately from being authorized to write. Both publish
  workflows now omit `registry-url` and name the registry on `npm publish` instead, and
  `node scripts/check-trusted-publishing.mjs` asserts the local preconditions — npm ≥ 11.5.1, OIDC
  variables present, no credential in the environment, and no credential key (`_auth`, `_authToken`,
  `username`, `_password`, `certfile`, `keyfile`) in the project, user, or global npm config — in the
  step immediately before `npm publish`, where nothing can run between the check and the publish. It
  reports without echoing any value, and a config it cannot read aborts the check. Environment detection mirrors
  npm's own `npm_config_` key normalization, so registry-scoped variables such as
  `npm_config_//registry.npmjs.org/:_authToken` — which npm accepts verbatim — are refused too.
  The workflows also split into `validate` → `prepare` → `publish`: `pnpm install` and `prepack`
  now run in an unprivileged job, and only the publish job holds `id-token: write`. That job treats
  the bundle as untrusted input: it derives the expected tag, dist-tag, tarball name, and file set
  from the checked-out manifest, recomputes the digests from the bytes, requires an exact checksum
  line, refuses unknown metadata keys, emits no shell (an earlier version was `eval`ed, and a
  crafted `distTag` ran arbitrary commands in the privileged job), and re-audits the tarball's
  contents with this repository's own auditor before publishing. It cannot
  confirm that a matching Trusted Publisher record exists on npm, and it does not preserve the
  version number:
  the workflow is tag-triggered, so the tag exists before any step runs. `@fairux/sdk` advances to
  `0.1.0-beta.2`; the `sdk-v0.1.0-beta.1` tag is kept unmoved as the record of the attempt.
- **The release runbook gave npm a workflow path where npm wants a filename.** The Trusted
  Publisher checklist said to set the workflow filename to `.github/workflows/publish-sdk.yml`;
  npm's field is the *filename*, so a path can never match, and npm does not validate the record
  when it is saved. The first `sdk-v0.1.0-beta.2` publish attempt
  ([run 30258382164](https://github.com/toshtag/fairux-linter/actions/runs/30258382164)) failed with
  `ENEEDAUTH` after the environment approval; nothing was published. npm names a workflow-filename
  mismatch as the first thing to verify for that error, so this instruction is the **leading
  hypothesis** — the record itself is external state no test in this repository can read, and it has
  not been read yet, so the exact external mismatch is unverified. That run did settle something
  else: the publish job reported `npm config files: none present`, so npm held no credential to
  misuse and said so, where `sdk-v0.1.0-beta.1` had held a broken one and failed later at the
  registry `PUT`. The checklist now names every Trusted Publisher field and its exact value, gives
  the exact read command with both registry keys pinned to public npm, and
  `tests/unit/trusted-publisher-docs-contract.test.ts` pins the documented filename to the real
  file's basename, the documented environment to the one the publish job declares, and that command
  to public npm. The tag is unmoved at the approved commit; the failed jobs can be re-run once the
  external record is verified, so no version is advanced.
- **Publishing a package was recorded as deploying the repository.** GitHub creates a deployment
  object and a deployment status whenever a job references an environment, so the failed
  `sdk-v0.1.0-beta.1` attempt left a red entry under `Deployments / publish` — describing a
  deployment that never happened, because uploading a tarball to a registry puts no revision
  anywhere. Both publish jobs now declare `environment: { name: publish, deployment: false }`. The
  `publish` environment remains the approval and OIDC boundary — required reviewer, wait timer,
  environment secrets and variables, and the `environment` claim npm's Trusted Publisher record
  matches are all unaffected — but npm publication no longer creates a GitHub deployment object.
  The workflow contract test pins the mapping for both workflows, asserts no other job references
  an environment, and is exercised against each way the declaration could drift back.
- **The release bundle was assembled in YAML, and the SDK's paths did not line up.** The checksum
  step wrote `release-sha256.txt` into `$RUNNER_TEMP/bundle`, a directory no step created, while the
  upload step read `$RUNNER_TEMP` — so the first `sdk-v*` tag after that change would have failed
  with `ENOENT`, and the checksum line it wrote recorded the tarball's *absolute path* where the
  verifier requires a basename. Neither was reachable from pull-request CI, because the publish
  workflows only run on a tag push. `scripts/assemble-release-bundle.mjs` now owns the bundle's
  layout for both workflows — exactly three files, flat — and
  `scripts/test-release-bundle-handoff.mjs` runs the assembler and the verifier together on a real
  filesystem in ordinary CI, on both supported Node.js floors.
- **The bundle verifier discarded entries instead of refusing them.** It filtered the downloaded
  directory listing down to regular files, so a bundle carrying a directory tree or a symlink
  alongside the three expected names verified as though it held only those three. Every entry is now
  reported with its filesystem kind, and anything that is not a regular file is a rejection.
- **A numeric prerelease was classified as stable.** Both workflows tested for a prerelease by
  looking for a letter after the hyphen, so `1.0.0-1` — a prerelease under SemVer — read as stable:
  the CLI would have published it to `latest`, and the SDK's beta-only gate would have refused a
  version it should have accepted. `scripts/release-version-contract.mjs` is now the single strict
  SemVer parser for both.
- **Release notes were written where lifecycle scripts run.** They become the GitHub Release body,
  so generating them in the unprivileged `prepare` job let that job choose text this repository
  publishes under its own name. The publish job now writes them from its own checkout, and the notes
  are no longer part of the bundle.
- **Packed tarballs were never checked for install hooks, and their members only by name.** A
  `prepack` script could have added `postinstall` to the published manifest — it would have run on
  every consumer's machine at `npm install`, and neither auditor looked at `scripts` at all. Members
  were listed with `tar -tzf`, which prints names only, so a symlink or hardlink named
  `dist/dom.js` was reported as present exactly like the file it replaced. Both auditors now share
  `scripts/packed-publish-contract.mjs`, which refuses any install-time script and pins entry
  points, script bodies, and every dependency range against the checkout, and
  `scripts/tar-members.mjs`, which reads the ustar headers directly and refuses any member that is
  not an ordinary file under `package/`. The manifest rules allow exactly the two rewrites
  `pnpm pack` genuinely performs, verified against real tarballs of both packages: it strips the
  publish-lifecycle scripts and resolves `workspace:` ranges.
- **A tarball member's name did not identify the member.** `tar -xzOf <path>` returns every member
  carrying that path, concatenated, while an extractor keeps the last one — so a tarball whose first
  `dist/dom.js` was `//` and whose second was `import "node:fs";` audited clean and extracted
  malicious. `package/dist/./dom.js` aliased the same file just as well. Members must now be
  canonical, control-character-free, and unique by exact path, resolved path, and case-folded path;
  the payload audits use that validated list instead of a second `tar -tzf`, and an archive that
  fails is never read from. The header parser is fail-closed too: a bad checksum, a non-octal
  numeric field, the GNU base-256 encoding, or a size running past the end of the archive is a
  refusal rather than a member that quietly reads as empty.
- **The packed manifest was checked field by field, so unlisted fields were free.** `os`, `cpu`,
  `libc`, `module`, and `bundleDependencies` were injected into the real SDK tarball without
  complaint — the first three restrict which machines may install the package at all. The comparison
  is now the whole object, against an expectation derived from the checkout, allowing only the two
  transforms `pnpm@10.33.2 pack` was measured to perform. `prepublish` and `dependencies` join the
  refused install-time scripts: npm deprecated `prepublish` precisely because it still runs on
  `npm install` and `npm ci`.
- **Release reads and writes could reach different registries.** `npm publish` named the registry;
  the `npm view` calls that plan the publish and verify it afterwards did not, so they resolved
  through npm's config layers. A single `@fairux:registry=` line in any project, user, or global
  `.npmrc` would have had the pre-publish existence check and the post-publish digest verification
  reporting success about a host the publish never touched. One constant now supplies the registry
  to every command, with `--prefer-online`, since a cached metadata document is not evidence about
  the registry's current state. The SDK publish job also runs the Trusted Publishing preflight
  before its first `npm view`, not only before `npm publish`.

  `--registry` alone was not enough for `@fairux/sdk`: npm resolves a **scoped** package through
  `@<scope>:registry` first and falls back to `registry` only when that key is absent, and a
  command-line `--registry` sets the fallback rather than the scope key — so a `@fairux:registry=`
  line in any `.npmrc` still decided where the SDK's reads and publish went. Every SDK command now
  pins both keys; the unscoped CLI package keeps `--registry` alone. Because asserting on flags
  cannot establish where npm actually sends a request — the first attempt at this fix shipped such
  a test, and it passed while the guarantee did not hold — `scripts/test-scoped-registry-routing.mjs`
  runs npm against two local HTTP servers with a hostile scope registry configured, and checks which
  one is asked, with a negative control for the previous arguments. That covers `npm install` as
  well as `npm view`: the post-publish smoke installs the published package, and carried no registry
  arguments at all — it would have installed from whatever `@fairux:registry` the operator's
  `.npmrc` named, proving nothing about what was just published.
- **The browser-entry audit moved to a real parser.** `import(/* webpackIgnore: true */ "node:fs")`
  defeated a regex, and the hand-written scanner that replaced it missed
  `` `${import("node:fs")}` `` — its own comment claimed template expressions were reached; they
  were not. Writing a JavaScript scanner out of Node built-ins, so that it could run in the publish
  job where no `node_modules` exists, was the wrong trade. The rule now runs unprivileged, in the
  pack smoke test and PR CI, over the TypeScript AST. The privileged publish job verifies the
  structural release contract — member identity, manifest, payload, digests, and the static module
  requests Node's own parser reports — and publishes the exact verified bytes without executing
  them; it makes no claim about arbitrary JavaScript semantics.
- **CI exercised the bundle envelope but not the audits inside it.** The handoff test chained the
  assembler to the verifier only, leaving both trusted auditors — the entire second half of each
  publish job — unrun until a tag fired. `scripts/test-packed-artifact-contract.mjs` now packs both
  packages for real, runs `pack → assemble → verify → trusted audit`, and rebuilds each tarball with
  every defect above, requiring rejection. It contacts no registry and mints no token.
- **The SDK's browser-entry audit missed side-effect imports.** "No Node builtin imports" was
  enforced with a regex keyed on `from "…"`, which `import "node:fs";` does not contain. Extraction
  now uses Node's own parser via `vm.SourceTextModule`, which parses without linking or evaluating,
  in an isolated child process.
- **`pnpm build` no longer writes into the source tree**
  ([#57](https://github.com/toshtag/fairux-linter/issues/57)). A build emitted 43 untracked
  `*.d.ts` files into `packages/core/src` and `packages/rules/src`, so `pnpm lint` failed after a
  build and repeated verification was non-idempotent — enough to corrupt a release-time write
  audit. Three tests imported a sibling package by relative source path, and because each package
  `tsconfig.json` includes `test`, those foreign sources entered the declaration program; tsdown's
  tsgo generator writes out-of-root declarations next to the source instead of into its temporary
  output directory. Fixed at the generation site: the tests now import package entry points, and
  the TypeScript configuration splits into a typecheck contract (`tsconfig.json`, `noEmit`) and a
  per-package declaration-emit contract (`tsconfig.build.json`, scoped to `src`). Emitted `dist/`
  output is byte-identical across the change, so no published declaration moved.

### Added
- **Build output contract**: `pnpm check:build-output` fails closed if anything at all lands below a
  `dist` directory that is not a real workspace's own output directory — whatever the file type,
  because a directory that is not a build directory explains a `.json`, `.html`, or `.css` no
  better than a `.js` — or if any compiler output lands inside a source tree or elsewhere outside
  `dist/`. Both allowances are decided from identities the gate discovers, not from the shape of a
  path: build directories come from the `package.json` manifests, so
  `packages/not-a-workspace/dist/` and a directory merely named `dist` are both refused; a
  hand-written `.mjs`/`.d.mts` is allowed only when that
  exact path is already tracked in the Git index, inside `scripts/` or `tests/fixtures/`, with no
  `dist` segment. It also fails if a package declares a type entry outside its own `dist/` or does
  not ship it, if `@fairux/sdk` is missing any of its three published entry points, or if the
  `fairux` CLI starts publishing declarations. It cannot lean on `git status`, which is blind here:
  `.gitignore` ignores `dist/` at any depth and the linter honours that ignore file — so the gate
  reads the Git index for source identity and walks the filesystem for output. A directory or an
  index it cannot read aborts the check rather than reading as empty. CI lints after building — not
  only before it — and a dedicated job builds twice on Node.js 22.18.0 and 24.11.0 and compares
  artifact digests, so the build is proven idempotent rather than assumed to be.
- **Workspace boundary contract**: a package reaching into another workspace's private `src/` is
  now a TypeScript error. Each package's `tsconfig.json` pins `rootDir` to the workspace root and
  each `tsconfig.build.json` pins it to `src`, so an emit-relevant foreign source file pulled in by
  a TypeScript-resolved dependency fails `pnpm typecheck` with `TS6059`. Measured coverage: static
  imports, dynamic `import()`, `import x = require(…)`, and directory imports; a plain `require(…)`
  call is a runtime call rather than a module reference and is not covered. Because the check reads
  the compiler's resolved program rather than source text, strings, comments, regular expressions,
  and JSX text do not become foreign program files and cannot be reported. Same-workspace relative
  imports and package-name imports are unaffected.
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
- **Generated governance verification closure**: governance and catalog generation are split into
  separate fail-closed commands, CI now checks review and catalog drift, the catalog is generated
  from the built `fairuxBuiltinRulePack` runtime metadata, and tests pin built-in runtime
  governance parity, deep freeze, execution metadata, representative findings, SARIF governance
  output, and packed SDK built-in governance metadata.
- **Runtime governance parity closure**: catalog generation now fails before artifact writes when
  actual built-in runtime governance differs from the review-derived projection, packed SDK smoke
  tests exact-compare all 13 installed-tarball built-in rule contracts against the generated
  catalog, SARIF tests cover experimental built-in metadata without generic help URIs, and the
  generated maintainer catalog exposes linked per-source review provenance for human review.
- **Built-in rule review approval closeout**: the 11 stable built-in review records are explicitly
  `maintainer-approved`, recorded from a pull request approval comment rather than inferred. The 2
  experimental records were reviewed and deliberately retained as `prepared`, `experimental`, and
  default-off. The decision acknowledges 13 documented uncovered scenarios as known, non-exhaustive
  coverage boundaries and records no approved open review exceptions. The approval target commit,
  substantive review fingerprint, comment URL, approver, and covered rule ids are checked in as
  `packages/rules/reviews/maintainer-approval.json`, and a new `rules:reviews:check:approved` gate
  re-verifies that evidence against the review packet in CI — pinning the approver and approval
  target, so adding a stable built-in rule without approval fails CI. Detection behavior is
  unchanged: the substantive review fingerprint and the generated runtime governance module are
  byte-identical across the approval.
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
