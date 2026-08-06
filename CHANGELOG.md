# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/), and the project aims to follow
[Semantic Versioning](https://semver.org/) once packages are published.

## [Unreleased]

Highlights of what exists today:

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
- **The CLI's dist-tag policy required a registry state npm does not permit.** It said `latest` must
  be **absent** until the first stable release, so that `npm install fairux` could not resolve a beta
  without also advertising a placeholder. npm sets `latest` to a package's first published version
  whatever `--tag` says — `--tag bootstrap` reserves the name and does not stop the placeholder
  becoming the default — and `npm dist-tag rm fairux latest` is refused with HTTP 400. The rule was
  unsatisfiable, and the preflight found it by refusing the first beta over a state no owner could
  reach. `latest` on the bootstrap placeholder is accepted now, `npm deprecate` is what keeps that
  placeholder from being installed in passing, and nothing else moves: `latest` still may not hold a
  beta or any other prerelease, the first stable release is still the only thing that moves it, and
  the workflow still creates, moves, and removes no dist-tag — teaching it to "repair" `latest`
  would have been rewriting registry state to make its own check pass. The runbook's instruction to
  remove the tag by hand is gone, replaced by why it is there and why it stays.
- **`--fix-write` failed on a file that was exactly what was asked for.** A built-in rule and a
  RulePack can reach the same conclusion about the same attribute — `consent/checked-checkbox`
  removing a pre-checked `checked`, and a pack under a different rule id proposing the same removal.
  The first edit landed; the second was resolved against text the first had already replaced and was
  refused as `expected-mismatch` (or `range-outside-file`, depending on how the edit moved the line),
  which the CLI counted as a safe fix that did not happen. The run left the correct bytes on disk,
  exited 1, and said the tree was partly fixed. A remediation whose **every** edit an earlier one
  already made identically is now coalesced: one physical edit, both remediations accounted for, and
  stderr naming which one made it. Identical means identical — the same file, scan-time checksum,
  start and end coordinates, expected text, and replacement — and the comparison is between what the
  two remediations asked for, never between one of them and the file as it now stands, so a file that
  happened to contain a plausible value is still caught. Every existing boundary is unmoved and each
  has a test that fails when its guard is removed: a different replacement, a partial overlap,
  different expected text, a different file, a different checksum, a stale file, `review-required`,
  and AI-origin all remain refusals and still exit 1. `--fix-dry-run` and `--fix-write` reach the
  classification through the same plan, as they already did.
- **`fairux scan` accepted flags it then ignored.** `--risk-index-model` without `--risk-index`
  computed no index and said nothing; `--write-baseline` returns before the suppression, baseline,
  index, fix, and `--fail-on` branches, so a command line carrying all of them exited 0 having acted
  on one; `--ignore-config` beside `--config` asked for a discovery pass that is never reached; and
  `--fix-dry-run` beside `--fix-write` asked not to write, and wrote. One table-driven validator now
  answers for every case, before filesystem discovery, before a scan, before a RulePack is imported
  as unsandboxed code, and before any output is opened. Nothing picks a winner between two flags: the
  run is refused with both named and exits 2. **Behaviour change:** each of those combinations used to
  be accepted.
- **A malformed `--suppress` or `--baseline` file cost a full scan first.** Both were read inside the
  emit path, which is reached only after the RulePack has been imported and every target scanned — so
  a missing reason or a wrong `schemaVersion` was reported after third-party code had already run with
  the user's privileges. Both files are now read immediately after the invocation is accepted.
- **A suppression could expire on a day the calendar does not have.** `expiresOn` was checked with a
  shape regex, and expiry compares dates as strings, so `2026-02-30` sorted after every real day in
  February and outlived the month it was written for with nothing said. Dates are now rebuilt in UTC
  and compared back. A duplicate fingerprint in either file is refused with both entry indexes named —
  two arguments for one decision, of which a run applied one silently — and a baseline now validates
  its whole consumed version-1 shape, including the `note`, `toolVersion`, and `createdAt` that tell
  whoever inherits it what the file is. Old valid v1 files stay readable: the note is never compared
  to this version's prose, `createdAt` accepts any ISO 8601 date-time, and unknown fields are ignored.
- **The Chrome extension could highlight the wrong element.** The DOM adapter walks into open shadow
  roots and gave every node it found there a flat CSS selector; no selector crosses a shadow boundary,
  so the content script resolved that path against the light DOM — and an `:nth-child` path usually
  matches *something*, which was then outlined as if it were the finding. The path was doubly wrong,
  because a host's shadow children and light children were numbered as one list. A `css` locator that
  crosses a boundary is now a sequence separated by ` >>> `, resolved one root at a time; a document
  with no shadow root produces exactly the flat selector it always did, and the separator is not valid
  CSS in any engine, so a consumer that does not split fails loudly rather than matching the wrong
  element. Unresolvable locations — including a host whose `shadowRoot` is absent — highlight nothing
  and say so. `aria-labelledby` ids are indexed per root, so a shadow element can no longer be named
  after a document label no browser would associate with it.
- **The Chrome popup's findings were reachable only by mouse.** A finding row was a list item with a
  click listener: no tab stop, no Enter or Space, no focus ring, and nothing announcing it as operable.
  A locatable finding is now a real button, each severity is a section with a heading and a named list,
  and the status line is a live region — a scan finishing, a scan failing, and a highlight that
  resolved nothing were all silent, and each is announced now.
- **VS Code ignored its own settings until something changed.** `fairux.enable` and `fairux.debounceMs`
  were read on every scan and watched by nothing, so turning FairUX off left every diagnostic on
  screen and an edit already in flight repainted them. Configuration changes now clear everything and
  cancel every pending rescan on disable, and rescan the supported open documents on enable. Closing a
  document cancels its pending rescan.
- **The Figma adapter trusted its input.** `JSON.parse(json) as FigmaFile` is a claim, not a check, and
  every field it claimed was read straight off the parsed value: a node with no name threw from frames
  away, and a `componentProperties` entry whose `value` was the string `"true"` was compared against
  `true`, answered "not checked", and produced a clean report for a pre-checked consent control. The
  consumed shape is validated as the tree is walked, under the existing node and depth limits, naming
  the node by path and id, and duplicate node ids are refused — a Figma id is the whole of a finding's
  locator. `mainComponent` is removed rather than implemented: it is a Plugin API property, the REST
  response gives an `INSTANCE` a `componentId`, and nothing read it.
- **The SDK browser bundle passed its ceiling between merges.** `pack:smoke:sdk` runs after a merge,
  so three pull requests each passed every check they were given and together added 3,150 unminified
  bytes, leaving the next release rehearsal red. Both pack smokes now run on the pull request, with a
  `paths` filter naming what the tarballs are built *from* rather than only what describes them. The
  unminified ceiling moved to 196 KiB with the measurement recorded; the minified one — the number
  worth being strict about — did not move.
- **SARIF no longer carries a FairUX-generated `primaryLocationLineHash`.** `@fairux/report` emitted
  `partialFingerprints.primaryLocationLineHash`, hashed from file, start line, and rule id. The line
  number was an input, so a one-line insert above a finding produced a different value — exact-location
  identity rather than the line-drift-tolerant identity GitHub code scanning uses for alert matching.
  For resolvable source locations, `github/codeql-action/upload-sarif` independently calculates a
  source-aware value, but it does not overwrite an existing `primaryLocationLineHash`; when the values
  differ, the Action warns and retains the producer-supplied one. FairUX's line-number-derived value
  could therefore remain the value sent to code scanning
  ([issue #78](https://github.com/toshtag/fairux-linter/issues/78)). The field is now absent, allowing
  the Action to populate its calculated value when its source-resolution requirements are satisfied.
  That is conditional, not a guarantee that every physical result receives a GitHub fingerprint, and
  this repository does not test an actual code-scanning upload. Logical-only DOM/Figma results have no
  physical source location to hash at all, and uploads that bypass the Action for the code-scanning
  REST API receive no substitute from FairUX. Unchanged: `fingerprints.fairuxV1` and its algorithm,
  physical and logical location mapping, severity mapping, rule metadata, and the JSON and Markdown
  reporters.
- **Two workflow actions still targeted Node 20.** Every CI run printed the runner's deprecation
  for `pnpm/action-setup`, and the pinned `actions/download-artifact` had the same problem —
  unseen only because the publish workflows run on a tag push and never appear in pull-request CI
  ([issue #64](https://github.com/toshtag/fairux-linter/issues/64)). Both moved to releases whose
  own `action.yml` declares `node24`, pinned by the commit each tag dereferences to:
  `pnpm/action-setup` v5.0.0 and `actions/download-artifact` v7.0.0. v6 of the download action was
  not enough — it announced Node 24 support while still declaring `node20` — and v6 of the pnpm
  action was not adopted, because of an open pnpm 10 identity regression and an open security
  report against its bundled bootstrap pnpm. Nothing else changed: no action gained an input, the
  root `packageManager: pnpm@10.33.2` remains the only authority on which pnpm runs, and the CLI
  and SDK artifact names and destinations are the same. Two things now prove that on every pull
  request rather than at release time — `scripts/check-pnpm-selection.mjs` compares the running
  pnpm against `packageManager` on Linux and on Windows before either job installs, and a pair of
  unprivileged canary jobs run the upload and download actions against each other and compare the
  extracted file set as well as its bytes.
- **The SDK's GitHub Release notes described a package nobody could install that way.** The body
  generated for `sdk-v0.1.0-beta.2` was a flat bullet list that said "Install after publication" of
  a published package and named an exact version rather than the `next` channel it is announced on;
  it explained no entry point, no provenance, and neither attached asset, and the Release title
  duplicated the version's `v` ([issue #63](https://github.com/toshtag/fairux-linter/issues/63)).
  `packages/sdk/scripts/release-notes.mjs` is now a pure generator plus a thin CLI behind a main
  guard, so importing it runs nothing. Every release-variable fact — package name, version,
  description, Node engines, public entry points, repository URL, tag, source commit, dist-tag,
  tarball name, checksum name — comes from the trusted checkout's manifest or from a value the
  release-bundle verifier derived inside the privileged publish job; the generator makes no npm or
  GitHub query, and refuses any of those that is not the expected one, including an embedded
  control character and a prerelease that is not a `beta`. The explanatory copy around them is
  version-controlled text in the generator, pinned by semantic tests rather than supplied as input.
  The body carries nine sections, once each, in a fixed order; the install command names `@next`
  and states that `latest` is unchanged; Node support is read from `engines.node`; and npm's
  `dist.integrity`, the Release's `release-sha256.txt`, and unsandboxed third-party RulePacks stay
  three separate claims. The SDK and root READMEs describe the published beta instead of an
  unpublished preview, and both now scope determinism to built-in scanning under a fixed scanner
  policy rather than to every finding the SDK can produce. The generator refuses a version it would
  misdescribe as a beta — a presentation guard, not the repository's publish eligibility contract,
  which is unchanged here and tracked separately in
  [issue #68](https://github.com/toshtag/fairux-linter/issues/68). **No publication state
  changes here:** no publish, no version change, no tag
  or dist-tag movement, and no asset upload. The published `sdk-v0.1.0-beta.2` Release has since
  been corrected in place with `gh release edit` alone, title and body only, once. Rereading it
  afterwards, `scripts/check-sdk-release-state.mjs` — which requires every compared identity to be
  present before it is compared — matched the Release, the annotated tag's dereferenced commit, the
  npm metadata, and the whole dist-tag map against their recorded values, and matched the published
  title and body against the notes regenerated from the manifest at the tag-resolved commit. How
  GitHub renders that Markdown is not something a source-text comparison can answer, so the page was
  read to its footer as a separate, non-machine step and recorded as one.
- **P20 is closed.** The SDK beta release phase ends with the corrected Release verified, the
  published artifact unmoved, and every SDK publish gate agreeing on what "beta" means. The CLI was
  not released in the same wave, so `fairux@0.1.0-beta.1 is installable` is recorded as
  non-applicable rather than met. One release-scoped follow-up stays open:
  [issue #69](https://github.com/toshtag/fairux-linter/issues/69) narrows the SDK package
  description at the next published version, because changing the manifest alone would leave the
  source disagreeing with `0.1.0-beta.2`'s already-published registry metadata.
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
  external record is verified, so no version is advanced. **Resolved:** the record was corrected and
  the re-run authenticated and published `@fairux/sdk@0.1.0-beta.2` from the same commit, which is
  consistent with the filename mismatch being the cause. What the record held before and after
  remains external state nothing here can read.
- **A successful publish was recorded as a failed release.** `@fairux/sdk@0.1.0-beta.2` published at
  14:47:32 in [run 30258382164](https://github.com/toshtag/fairux-linter/actions/runs/30258382164),
  and the digest verification that started in the same second read the version as absent and failed
  the job, so the release notes and GitHub Release steps never ran — the package existed on npm with
  no Release, and recovery took a manual re-run plus a second environment approval
  ([issue #62](https://github.com/toshtag/fairux-linter/issues/62)). That step performed a single
  `npm view`, and under `--require-present` an absent answer exited immediately, with no allowance
  for a write the registry had already accepted becoming readable a moment later. It now passes
  `--wait-for-present`, which re-reads an **absent** version on a fixed backoff schedule — 2s, 5s,
  10s, 20s, 30s, 30s — sleeping at most 97 seconds across up to seven reads, under an **absolute
  120-second deadline covering the reads as well as the sleeps**. Each `npm view` is limited to the
  remaining deadline and reads through a per-attempt cache directory. Bounding only the sleeps would
  not have been a bound at all: with reads taking 30s each, a sleep-capped loop slept its 97s and ran
  for 307s, and since the release helpers give each `npm view` its own 120s timeout, seven reads plus
  the schedule reach 937s. The loop refuses to start a read or a sleep it cannot finish inside the
  deadline rather than trimming one to fit, re-reads the budget after the attempt observer so a slow
  callback cannot spend what the sleep decision already assumed, measures with a monotonic clock so
  an NTP correction cannot extend or expire it, and accepts a matching version only when it was
  **observed by** the deadline — checking the budget before the read and not after let a 121-second
  read return success against a 120-second contract. It is a policy deadline, not a hard real-time
  guarantee: nothing new starts beyond it and nothing observed beyond it is accepted, but process
  teardown can carry the wall clock slightly past. Nothing else waits. A present version with a
  different shasum or integrity is a different artifact under a specifier npm treats as immutable,
  and a digest mismatch is reported as a mismatch however late it arrives; retrying any of them would
  report a digest mismatch as a timeout. Only `E404` means absent — the read the wait uses raises
  every other command, network, auth, or timeout failure rather than reporting it as a registry
  state, and a subprocess the deadline killed is raised as a typed timeout — classified before its
  output is parsed, since a read killed mid-flight can leave `404` in stderr and reading that first
  turned "this read never finished" into "the version is not there". Reported as
  `unavailable`, as they had been, a killed read and an expired credential were indistinguishable
  from the registry answering, and a retry loop one npm outage away from waiting out an auth error.
  The wait also refuses to run without a deadline-aware reader rather than falling back to a plain
  registry read that would leave the subprocess unbounded, and an explicit `maxElapsedMs` of `0` or
  `NaN` now reaches validation instead of being dropped in favour of the default. The wait is rejected without `--require-present`, so the pre-publish
  plan — where absence is the expected answer and the publish is the fix — stays a single read, and
  `tests/unit/workflows/registry-visibility-contract.test.ts` fails if the flag is dropped after the
  publish or added before it. No version, tag, dist-tag, or authentication policy changed, and
  nothing here asserts how long npm takes to make a publication visible — only how long this
  repository waits before calling the release failed.
- **The release check required the status document to say something false.** The SDK preflight
  asserted that `docs/status.md` contained the literal `has not been published to npm`, which held
  exactly until the first release; once `@fairux/sdk@0.1.0-beta.2` was on npm, correcting the
  document failed CI for correcting it. Replacing that with a search for either phrase was worse: it
  read as "exactly one publication claim" while asserting two booleans over the whole file, so the
  same sentence written twice passed, and so did a claim about `0.1.0-beta.1` while `0.1.0-beta.2`
  appeared in an unrelated roadmap line. The document now carries a single machine-readable
  publication record — one table, one row, a package spec and a state — and
  `readSdkPublicationStatus` requires exactly one such table, exactly one record, the exact package
  and version from the SDK manifest, and a state that is exactly `published` or `unpublished`. It
  reports the state rather than requiring a value: which one is correct is a fact about the
  registry, which `release-registry-plan.mjs` asks over the network, and pinning it here would break
  re-running a publish workflow against a version that is already up. Both mutations that defeated
  the previous form are unit tests. The parser skips the opaque source
  contexts it recognises, and requires the record itself at column zero: a record inside a fenced code block — and this document
  documents the format, so an example of it is exactly what sits in a fence — satisfied an earlier
  version while no canonical record existed outside that context, as did one inside an HTML comment, an indented code
  block, or a `<pre>`, `<script>`, `<style>`, `<textarea>`, `<div>`, CDATA, processing-instruction,
  or declaration block; and a two-column header with a three-column separator passed as a
  well-formed table. All of those are excluded, including everything after one that is never closed,
  and HTML comment delimiters are tracked in order so a closed comment cannot mask an unclosed one
  on the same line. A second live publication table is refused, and the separator's column count
  must equal the header's. Markdown would allow the heading and rows up to three
  spaces of indent, which is indistinguishable from list-continuation indent — a record nested under
  a list item satisfied the check while being that item's content — so the canonical record is
  column-zero, narrower than Markdown, rather than the parser analysing list nesting. Within the enumerated contexts an
  unclosed block keeps every later line skipped, so a missing terminator cannot reopen what the block
  was holding; syntax outside those contexts is not interpreted as part of this contract. It is not a Markdown renderer, an HTML parser, or
  a check on what a browser displays.
- **The SDK consumer smoke could not fail the command that ran it.** `runConsumerSmoke` returned a
  boolean that both `pnpm registry:smoke:sdk` and `pnpm pack:smoke:sdk` ignored, so a failed check
  printed `✗` and the process still exited 0 — measured with a deliberately wrong
  `EXPECTED_VERSION` against the published package. That is the check P20's definition of done rests
  on for "installable from the npm registry". The failed checks are now collected and raised, both
  callers already treat a throw as failure, and the same command exits 1.
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
- **One built-in rule proposes a fix, and `--fix-write` has something to apply.** The remediation
  schema and the applier shipped before anything produced one, so both flags reported an empty
  pipeline. `consent/checked-checkbox` now offers to delete the `checked` attribute from a
  pre-checked consent box in static HTML — the only remediation any built-in rule proposes, and that
  is the design: rewording a label or reordering two controls changes what a page *says*, and no
  rule can know whether the replacement is true. Nothing about the edit is inferred. `@fairux/rules`
  is browser-safe and cannot open a file, so the range comes from the parser, the expected text comes
  from the same read, and the checksum covers the bytes both were computed against; where any of that
  is missing there is **no remediation**, never a `review-required` one that would claim a fix exists
  and leave a reader to refuse it. Four refusals, each with a test that fails when its guard is
  removed: a document not declaring `source-range`, one that does not name its file or carry a
  checksum, a node with no recorded range, and a range holding anything but a plain boolean `checked`.
  The last is the boundary worth knowing: HTML treats a boolean attribute as true whenever it is
  present, so `checked="yes"` is a pre-checked box that is **reported with no fix**, because the
  removable set is the one whose meaning is beyond argument rather than the one a reading of the spec
  would allow. Covered end to end through the CLI, including CRLF files, an attribute on its own
  line, every supported spelling, idempotence, and a stale checksum. Detection is unchanged, and the
  rule moved to 1.2.0 because a finding is a different shape.
- **`pnpm verify:full`, the whole offline gate in one command.** `pnpm verify` covers lint, a
  build-backed typecheck, the suite, and runtime safety; everything else lived only in CI, so a
  contributor learned about it from a red check after pushing. The new script composes the existing
  ones — nothing in it reimplements a check — and adds the document and third-party fixture checks,
  build-output isolation, every generated artifact this repository checks in, and both package
  smokes. It runs every step and reports all the failures rather than stopping at the first, and it
  stays offline: no registry, no token, nothing about what is published. A contract test compares its
  list against `ci.yml`, so a check added to the lane and not to the gate fails. `pnpm verify` is
  unchanged and a test holds that.
- **The packed CLI is verified on Windows, not only on Linux.** `pnpm pack:smoke` now runs on
  `windows-latest` as well as `ubuntu-latest`, on Node.js 22.18.0 and 24.11.0, and it is the same
  command on both: the same archive audit and the same installed-CLI contract, rather than a
  reduced Windows variant that could drift. The CLI is launched through the executable npm
  generates for it — `fairux.cmd` on Windows — instead of a hard-coded `node_modules/.bin/fairux`
  or `node dist/index.js`, so a published `bin` entry that npm never linked is a failure rather
  than something the test worked around. The contract covers identity, the HTML/JSX/TSX adapters,
  stdin/file/directory/glob targets, Markdown/JSON/SARIF output, config auto-discovery, an explicit
  trusted config, and exit codes 0/1/2, and it asserts that report and SARIF paths carry no drive
  letter, backslash, or absolute temporary directory — a Windows separator would otherwise reach
  SARIF as `%5C` and make the same file two identities. Reaching this required the audit to stop
  depending on `sha256sum`, `sh`, and an external `tar`: archive members are now read with Node
  built-ins, which also removes a second, independent decompression that could disagree with the
  header audit it followed. `npm` and `pnpm` are launched through one runner that resolves
  `PATHEXT` and confines `cmd.exe` to `.cmd`/`.bat` targets, so a glob argument reaches the CLI
  literally on every platform. The installed-CLI contract takes an already-installed CLI, so the
  registry-installed smoke can reuse it unchanged. The Windows job grants only `contents: read`.
  The matrix also found a CLI defect that is **not** fixed here: a glob written with the platform's
  own separator (`fairux scan "inputs\*.html"`) matches nothing, because a backslash in a pattern
  is an escape character and neither `cmd.exe` nor PowerShell expands globs. The portable
  `inputs/*.html` works and is what the contract pins; the defect is tracked in
  [issue #84](https://github.com/toshtag/fairux-linter/issues/84). No npm package, tag, or Release
  is affected.
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

## [@fairux/sdk 0.1.0-beta.3] — 2026-08-01

Published to npm on the `next` dist-tag, from tag `sdk-v0.1.0-beta.3`, with provenance. `latest`
still names `0.0.0-bootstrap.0`, so the beta is opt-in: `npm install @fairux/sdk@next`. The release
record, including the registry read-back, is in
[the SDK release runbook](docs/maintainers/release-sdk.md).

- Narrow the published SDK description so it no longer promises determinism for everything the SDK
  returns. A third-party RulePack's `evaluate()` is ordinary JavaScript, and built-in scanning is
  policy-dependent — locale, enabled packs, experimental rules, and overrides all change the
  findings for the same document.
- Narrow the Release notes' trust claims to what the privileged workflow actually verifies, and add
  the SDK provenance read-back the CLI path has had since M1-R2.
- No change to the public API, the exported entry points, the report schema, or scanner behaviour.
