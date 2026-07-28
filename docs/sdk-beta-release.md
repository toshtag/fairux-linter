# SDK beta release runbook

This runbook tracks the `@fairux/sdk@0.1.0-beta.2` release path. It does not authorize a publish by
itself.

## Release Automation

The SDK release is separate from the CLI release:

- CLI workflow: `.github/workflows/publish-cli.yml`, triggered by `v*` tags, version source
  `apps/cli/package.json`.
- SDK workflow: `.github/workflows/publish-sdk.yml`, triggered by `sdk-v*` tags, version source
  `packages/sdk/package.json`.

The first SDK beta tag is:

```text
sdk-v0.1.0-beta.2
```

The SDK workflow packs the SDK tarball once:

```bash
pnpm --filter @fairux/sdk pack --pack-destination "$RUNNER_TEMP"
```

That same tarball is hashed, smoke-tested, audited, uploaded, published, and attached to the GitHub
Release.

## Local Preflight

Before asking for release approval, run:

```bash
pnpm install --frozen-lockfile
pnpm lint
pnpm build
pnpm check:build-output
pnpm lint
pnpm typecheck
pnpm test
pnpm check:runtime-safety
pnpm rules:reviews:check
pnpm rules:reviews:check:approved
pnpm rules:catalog:check
pnpm pack:smoke
pnpm pack:smoke:sdk
pnpm release:check:sdk -- --tag sdk-v0.1.0-beta.2
pnpm release:dry-run:sdk -- --tag sdk-v0.1.0-beta.2
pnpm test:rule-pack-author-example
pnpm exec code-pact validate --json
pnpm exec code-pact plan lint --json
git diff --exit-code
test -z "$(git status --porcelain)"
```

The second `pnpm lint` and the closing worktree assertions are not padding. A release is only
reproducible if the build changes nothing outside `dist/`, so every step above must leave the tree
exactly as it found it — see [Build output contract](#build-output-contract).

`pnpm pack:smoke:sdk` also accepts an exact tarball contract used by the workflow:

```bash
TARBALL=/path/to/fairux-sdk-0.1.0-beta.2.tgz \
EXPECTED_SHA256=<sha256> \
pnpm pack:smoke:sdk
```

## External Configuration Checklist

Repository owners must complete these before pushing the release tag:

- npm scope ownership for `@fairux`;
- permission to publish `@fairux/sdk`;
- npm Trusted Publisher configured for this repository, with the exact field values below;
- npm package access is public;
- GitHub `publish` environment exists;
- environment protection and reviewer requirements are intentional;
- release approver has reviewed the exact commit on `main`;
- package version is not already present on npm.

Do not add an npm token secret as a workaround. The intended release path is Trusted Publishing via
OIDC provenance.

### Trusted Publisher record — exact field values

On npmjs.com, under `@fairux/sdk` → Settings → Trusted Publisher:

| Field | Value |
| --- | --- |
| Provider | GitHub Actions |
| Organization or user | `toshtag` |
| Repository | `fairux-linter` |
| Workflow filename | `publish-sdk.yml` |
| Environment name | `publish` |
| Allowed actions | `npm publish` |

**The workflow filename is a basename, not a path.** npm's field is "the filename of your workflow";
`.github/workflows/publish-sdk.yml` is not a value npm will ever match. npm does not validate the
record when it is saved, so a path is accepted at save time and could only fail at publish — with
`ENEEDAUTH`, which reads as "you are not logged in" rather than "this record does not match". This
document instructed owners to enter the full path until the first `sdk-v0.1.0-beta.2` attempt
failed with exactly that error; see the release attempt history below for what is and is not
established about the connection.

### Reading the record

The record lives on npm. Nothing in this repository can read it — this is a check the owner
performs, and the values above are what they check against.

```bash
npx --yes npm@^11.15.0 trust list @fairux/sdk \
  --json \
  --registry=https://registry.npmjs.org/ \
  --@fairux:registry=https://registry.npmjs.org/
```

- `npm trust` requires **npm ≥ 11.15.0**; the npm shipped with this project's Node.js floors is
  older, hence `npx`.
- Both registry keys are pinned, for the same reason every other npm read here pins them: npm
  resolves a scoped package through `@fairux:registry` first and only falls back to `registry`, so
  `--registry` alone leaves any `@fairux:registry=` line in an npmrc in charge of which host is
  asked. Checking the Trusted Publisher record against the wrong registry is exactly the class of
  mistake this document exists to prevent.
- The first trust request may require **browser-based 2FA**. Do not record the authentication URL,
  the one-time password, or any token in a log, an issue, or a pull request.

npmjs.com → `@fairux/sdk` → Settings → Trusted Publisher shows the same values, and is the way to
change them. npm does not validate the record on save, so re-open the page afterwards and read the
stored values rather than trusting that the save succeeded.

## Beta-Only Policy

P20 is scoped to the SDK beta line. The `publish-sdk.yml` workflow refuses stable versions without a
prerelease marker and publishes with npm dist-tag `next`. Stable SDK release policy belongs in a
future task.

Release notes are generated from `packages/sdk/package.json` / `SDK_VERSION`; do not hard-code the
install version in workflow YAML.

## Approval Boundary

Without explicit owner release approval, do not run:

```bash
git tag sdk-v0.1.0-beta.2
git push origin sdk-v0.1.0-beta.2
npm publish
```

The PR may prepare automation and dry-run checks only. Public publication, GitHub Release creation,
and registry-installed smoke tests happen after approval and tag push.

## Release attempt history

### `sdk-v0.1.0-beta.1` — attempted, never published

| | |
| --- | --- |
| Tag | `sdk-v0.1.0-beta.1`, immutable at `960146d44258d635d97e235770d4e4eb010e5435` |
| Workflow run | [30233771956](https://github.com/toshtag/fairux-linter/actions/runs/30233771956) |
| Registry publication | **none** — `npm view @fairux/sdk@0.1.0-beta.1` returns `E404` |
| Sigstore transparency log index | `2256821583` |

`sdk-smoke` passed on both Node.js floors, the tarball was packed, smoke-tested, audited, and
digest-verified, and npm signed a provenance statement. The registry `PUT` then failed:

```text
npm error code E404
npm error 404 Not Found - PUT https://registry.npmjs.org/@fairux%2fsdk
npm error 404  The requested resource '@fairux/sdk@0.1.0-beta.1' could not be
               found or you do not have permission to access it.
```

The failure matches the known `actions/setup-node` `registry-url` / `NODE_AUTH_TOKEN` placeholder
mode. Removing `registry-url` was the recovery under test, and the first `0.1.0-beta.2` attempt
confirmed that half: the publish job reported `npm config files: none present`, so npm held no
credential at all and said so, instead of using a broken one. It did not publish either — a second,
independent misconfiguration was underneath, in npm's Trusted Publisher record rather than in this
repository. The mechanism here: `actions/setup-node`
was given `registry-url`, which writes `//registry.npmjs.org/:_authToken=${NODE_AUTH_TOKEN}` into
the job's npm user config. Trusted Publishing sets no token, so every step in the run logged
`Failed to replace env in config: ${NODE_AUTH_TOKEN}` and npm saw an unresolvable credential rather
than none — it never entered the OIDC exchange, and the run's log contains no OIDC line anywhere.
The npm CLI was 11.6.1, above the 11.5.1 floor, so version was not the constraint.

Provenance signing succeeding proves nothing about authorization: `--provenance` signs with the
GitHub OIDC token directly, which is a separate step from being allowed to write to the registry.
**No published package carries that provenance statement** — the signature exists only in the
transparency log, for an artifact that was never accepted.

The tag is kept as-is. It is not moved, deleted, or force-updated: it marks a real attempt, and
reusing it would make the record dishonest. Recovery advances the version to `0.1.0-beta.2`.

`node scripts/check-trusted-publishing.mjs` runs immediately before `npm publish`, where nothing can
introduce a credential between the check and the publish it guards. The SDK job runs it **twice**,
for two different reasons: once before `release-registry-plan.mjs`, because that step calls
`npm view` and a static credential in this job's config would otherwise reach the registry on that
call, and once immediately before the publish. The CLI job makes no `npm view` call, so it runs the
check once.

Every registry command names the registry explicitly, from one constant in
`scripts/public-npm-registry.mjs`. `npm publish` already did; the `npm view` calls did not, so they
resolved through npm's config layers instead — `registry=`, `@fairux:registry=`,
`NPM_CONFIG_REGISTRY`, and three `.npmrc` files. A single `@fairux:registry` line would have had the
pre-publish existence check and the post-publish digest verification reading one host while the
publish wrote to another, each reporting success about a different registry. `--prefer-online` goes
with it: a cached metadata document is not evidence about the registry's current state, which is the
only thing those calls ask about.

For `@fairux/sdk`, `--registry` alone does not do it. npm resolves a **scoped** package through
`@<scope>:registry` first and only falls back to `registry` — `pickRegistry()` in
`npm-registry-fetch` — and a command-line `--registry` sets the fallback, not the scope key.
Measured directly:

```
.npmrc:  @fairux:registry=https://wrong.invalid/

npm config get @fairux:registry --registry=https://registry.npmjs.org/
  → https://wrong.invalid/          (the flag did not reach the scope key)

npm config get @fairux:registry --registry=… --@fairux:registry=…
  → https://registry.npmjs.org/
```

So every SDK command — the two `npm view` calls and `npm publish` — pins **both** keys. The CLI
package is unscoped, has no scope key to override, and keeps `--registry` alone.

Asserting the flags are present does not establish where npm sends the request; the round before
this one shipped exactly that test, and it passed while the guarantee did not hold.
`scripts/test-scoped-registry-routing.mjs` therefore runs npm against two local HTTP servers, with a
hostile `@fairux:registry` in a temporary user config, and checks which server is asked — including
a negative control showing that the earlier arguments really did route to the wrong host. It touches
no external network and no credential.

It checks the **local** prerequisites: npm ≥ 11.5.1, both OIDC request variables present, no
credential in the environment, and no credential key — `_auth`, `_authToken`, `username`,
`_password`, `certfile`, `keyfile` — in the project, user, or global npm config. A config it cannot
read aborts the check rather than being treated as empty. It reports without echoing any value.

Environment detection mirrors npm's own `npm_config_` key normalization, transcribed from
`@npmcli/config`: keys beginning with `//` are **not** normalized, so
`npm_config_//registry.npmjs.org/:_authToken` is a real registry credential and is refused, while
`NPM_CONFIG_REGISTRY` and `NPM_CONFIG_AUTH_TYPE` are not credentials and are not.

### `sdk-v0.1.0-beta.2` — published, on the third attempt

| | |
| --- | --- |
| Tag | `sdk-v0.1.0-beta.2`, at `516b2473a7adaa24dd250ec20f916cf53bd9fa28` |
| Workflow run | [30258382164](https://github.com/toshtag/fairux-linter/actions/runs/30258382164) — attempt 1 `failure`, attempt 2 `failure`, attempt 3 `success` |
| Registry publication | `@fairux/sdk@0.1.0-beta.2` on the `next` dist-tag |
| `dist.shasum` | `f89bb1c9165c9d16397534c33746e9edc8ee4bf4` |
| `dist.integrity` | `sha512-yKVdIS5YJORayBq7vcdbMJklWVNms2OFmF9ujZGUKn503V45UevxLorzEHmV2DDICu6LHvYsoao5qu4P9ltp9g==` |
| `dist.fileCount` / `dist.unpackedSize` | 14 / 451768 |
| GitHub Release | `sdk-v0.1.0-beta.2`, prerelease, published 2026-07-27T23:14:19Z, with the tarball and `release-sha256.txt` |

Three attempts, failing in three different places. The tag was never moved, deleted, or re-cut:
GitHub Actions re-runs a failed job on the original `GITHUB_SHA` and `GITHUB_REF`, so every attempt
published the same version from the same approved commit.

#### Attempt 1 — `ENEEDAUTH`

`validate`, both `sdk-smoke` floors, and `prepare` succeeded, the owner approved the `publish`
environment, and the publish command failed:

```text
npm error code ENEEDAUTH
npm error need auth This command requires you to be logged in to https://registry.npmjs.org/
```

This is a **different failure than beta.1**, and the difference is the evidence that the
`registry-url` fix worked. Both runs of `check-trusted-publishing.mjs` reported `npm config files:
none present` — npm held no credential to misuse, so it reported honestly that it came away with
nothing. beta.1, by contrast, held a broken credential, never entered the exchange, and failed later
at the registry `PUT`.

The finding that belonged to this repository, independent of npm's record: this runbook told owners
to register `.github/workflows/publish-sdk.yml` where npm's field is a basename, so the instruction
was wrong on npm's own terms. It is now pinned by
`tests/unit/trusted-publisher-docs-contract.test.ts`.

The owner corrected the Trusted Publisher record between attempts 1 and 2, and attempt 2
authenticated and published. That is consistent with the workflow-filename mismatch being the cause
and is as far as the evidence here goes: what the record held before and after is external state
nothing in this repository can read.

#### Attempt 2 — published, then reported as a failure

```text
14:47:26 -> 14:47:32  Publish SDK to npm       success
14:47:32 -> 14:47:32  Verify registry digest   failure
                      ERROR: @fairux/sdk@0.1.0-beta.2 is absent from npm after publish
```

The publish succeeded. The verification that started in the same second read the version as absent
and failed the job, so `Write SDK release notes` and `Create SDK GitHub Release` never ran and the
release was left half-finished: the package on npm, no Release. It later became visible with exactly
the expected digests, file count, unpacked size, `next` dist-tag, and provenance attestation.

That step performed a single `npm view`, and under `--require-present` an absent answer exited 1
immediately, with no allowance for a write the registry had already accepted becoming readable a
moment later ([issue #62](https://github.com/toshtag/fairux-linter/issues/62)). Recovery took a
manual `gh run rerun --failed` and a second `publish` environment approval.

#### Attempt 3 — verified and released

The plan step found the version present with matching digests, so `npm publish` was skipped — the
rerunnable path P20-T2 built for exactly this. The digest verification passed, the release notes
were written, and the GitHub Release was created with both assets.

#### What P20-T4 changed

`Verify registry digest` now passes `--wait-for-present`, which re-reads an **absent** version on a
fixed backoff schedule — 2s, 5s, 10s, 20s, 30s, 30s — sleeping for at most 97 seconds across up to
seven reads. An **absolute 120-second deadline** covers both the reads and the sleeps, so how many
reads actually happen depends on what the reads cost. Every other outcome still fails on the first
read. A present version with a different shasum or integrity is a different artifact under a
specifier npm treats as immutable, malformed metadata is a broken read, and a failed `npm view` is a
failed `npm view`; none of them becomes true by waiting, and retrying them would report a digest
mismatch as a timeout.

The deadline is absolute because a sleep-only bound is not a bound. The first version of this fix
capped the delays at 97s and left the reads unbounded: with reads taking 30s each it slept its 97s
and ran for 307s, and in production each `npm view` carried the release helpers' own 120s subprocess
timeout, so seven reads plus the schedule could have reached 937s. Each read is now issued with the
remaining budget and limited to it, and the loop refuses to start a read or a sleep it cannot finish
inside the deadline rather than trimming one to fit. The clock is monotonic, so an NTP correction
cannot extend or expire it.

The wait is an explicit flag, accepted only alongside `--require-present`, so `Plan npm publication`
cannot acquire it: absence there is the expected answer and the publish is what resolves it.
`tests/unit/workflows/registry-visibility-contract.test.ts` fails if the flag is dropped after the
publish or added before it, and feeds each step's arguments to the real parser rather than matching
them as text.

Each attempt reads through its own npm cache directory, under a root created for the step and
removed when it exits. `--prefer-online` already revalidates, but this is the one place a response
is re-read on a schedule, and a per-attempt directory makes "a cached negative cannot survive into a
later attempt" structural rather than a property of revalidation.

This does not assert anything about how long npm takes to make a publication visible. It bounds how
long this repository is willing to wait before calling the release failed.

### Privilege boundary

The publish workflows split into `validate` → `prepare` → `publish`, and only `publish` holds
`id-token: write`.

The `publish` environment remains the approval and OIDC boundary, but npm publication does not
create a GitHub deployment object. Both publish jobs declare it as:

```yaml
environment:
  name: publish
  deployment: false
```

The required reviewer, the wait timer, the environment secrets and variables, and the `environment`
claim that npm's Trusted Publisher record matches all still apply — `deployment: false` suppresses
only the deployment object and the deployment-history entry. Nothing about this release is a
deployment: it uploads a tarball to a registry and puts no revision anywhere, so the record
described something that never happened, and the failed `sdk-v0.1.0-beta.1` attempt read under
`Deployments / publish` as a failed deployment of the repository. `tests/unit/workflows/publish-oidc-contract.test.ts`
pins the mapping for both workflows and asserts that no other job references an environment.

This is incompatible with custom deployment protection rules, which need a deployment object to
gate. The `publish` environment has none (`deployment_protection_rules` returns
`total_count: 0`); adding one later means reverting to a deployment-creating environment.

`prepare` is where `pnpm install` and `prepack` run — that is, where dependency and package
lifecycle scripts execute. It has `contents: read`, no environment, and no OIDC token, so nothing
it runs can mint a token, publish, or write to the repository. It packs the tarball once, smokes
and audits it, and uploads a bundle of exactly three files: the tarball, `release-sha256.txt`, and
a `release-metadata.json` naming the package, version, dist-tag, digests, tag, and commit.

`scripts/assemble-release-bundle.mjs` builds that bundle for both workflows, so its layout has one
owner. Assembling it in YAML did not work: the SDK's checksum step wrote into a directory no step
created while the upload read the parent, and the checksum line recorded the tarball's absolute
path where the verifier requires a basename. Neither is reachable from pull-request CI, because the
publish workflows only run on a tag push — so two CI jobs run the real executables on every PR.
`scripts/test-release-bundle-handoff.mjs` chains the assembler to the verifier on a real
filesystem; `scripts/test-packed-artifact-contract.mjs` packs both packages for real, runs the full
`pack → assemble → verify → trusted audit` chain, and then rebuilds each tarball with a duplicate
member, a dot-segment alias, a case collision, an injected manifest field, a `prepublish` script, a
`postinstall` script, and an obfuscated dynamic import, requiring each to be rejected. The negatives
are derived from the current artifact rather than checked in, so they cannot drift away from the
thing they model. Neither job contacts the registry or mints a token.

Release notes are **not** in the bundle. They become the GitHub Release body, so producing them in
`prepare` would have let a job that ran lifecycle scripts choose the text this repository
publishes. The publish job writes them from its own checkout.

`publish` installs nothing and builds nothing, and treats the bundle as **untrusted input** —
because it is: a lifecycle script in `prepare` could have written any of it.

`scripts/verify-release-bundle.mjs` derives the expected tag, dist-tag, tarball filename, spec, and
exact bundle file set from the *checked-out manifest*, recomputes SHA-1/SHA-256/integrity from the
bytes, and requires `release-sha256.txt` to be exactly `<sha256>␣␣<tarball>`. The metadata may only
agree with those values; it decides nothing. Unknown metadata keys are refused rather than ignored.
Every bundle entry must be a **regular file**: the verifier used to filter the directory listing
down to files, so a bundle carrying a directory tree or a symlink alongside the three expected names
verified as though it held only those three.

Whether a version is a prerelease is decided by `scripts/release-version-contract.mjs`, a strict
SemVer parser. The shell test it replaced looked for a letter after the hyphen, so `1.0.0-1` read as
stable — which for the CLI would have meant publishing it to `latest`.
The verifier writes to `GITHUB_ENV` and emits no shell — an earlier version printed
`export KEY='value'` for the workflow to `eval`, and a crafted `distTag` executed arbitrary
commands in the job holding `id-token: write`.

Identity is not content, so the publish job then re-audits the packed bytes with **this checkout's
own auditor** — `release-check.mjs` for the SDK, `audit-packed-tarball.mjs` for the CLI — and
re-computes the digest afterwards to prove the audit changed nothing.

Both auditors share two contracts, and both run **before** either reads a byte out of the archive.

`auditTarMembers` reads the ustar headers directly, because `tar -tzf` prints names only. A symlink
named `dist/dom.js` lists exactly like the file it replaces. Worse, a name does not identify a
member at all: `tar -xzOf <path>` returns *every* member with that path, concatenated, while an
extractor keeps the last one. A tarball whose first `dist/dom.js` was `//` and whose second was
`import "node:fs";` audited clean and extracted malicious — reproduced against the real SDK
artifact, as did `package/dist/./dom.js` aliasing the same file. Members must therefore be regular
files, canonical, under `package/`, free of control characters, and **unique** — by exact path, by
resolved path, and after case folding. The payload audits then use that validated list rather than a
second `tar -tzf` that could disagree, and an archive that fails here is never read from.

`auditPublishedManifest` compares the **whole** packed manifest against an expectation derived from
the checkout by `scripts/expected-packed-manifest.mjs`. A list of pinned fields was the wrong shape:
every field not on the list was free, and `os`, `cpu`, `libc`, `module`, and `bundleDependencies`
were injected into the real SDK tarball without complaint — the first three decide which machines
may install the package at all. A whole-object comparison only works if every packer transform is
known, so those were measured against `pnpm@10.33.2 pack` for both packages. There are exactly two:
publish-lifecycle scripts are removed, and `workspace:*` resolves to the referenced workspace's own
version. Anything else the packer starts doing stops a release until someone looks at the tarball —
the intended failure mode. Install-time scripts are refused outright in both the checkout and the
tarball, and that list includes `prepublish`, which npm deprecated precisely because it runs on
`npm install`, and `dependencies`, which runs whenever an install changes `node_modules`.

### What each job is responsible for

The prepare artifact is treated as untrusted for **identity, metadata, paths, and shell
interpretation**. The publish job does not claim to prove what arbitrary JavaScript does.

The privileged publish job verifies the structural release contract — tar member identity, the
packed manifest, the payload allowlist, required files, digests, and the static module requests
Node's own parser reports — and publishes the exact verified bytes without executing them. It has no
`node_modules`, by design, so every check it runs uses Node built-ins and `tar` only.

Semantic checks on the built bundle run **unprivileged**: in the `prepare` job's pack smoke test and
in PR CI, where the pinned lockfile has been installed and a real parser is available.

That split was learned the hard way. The browser entry's "no runtime module loads" rule was first
enforced by a scanner written out of Node built-ins so it could run in the publish job. Its own
comment claimed that code inside a template literal's `${}` was still reached; it was not — the scan
skipped to the closing backtick — so `` `${import("node:fs")}` `` and `` `${require("fs")}` ``
passed. Each round of fixes bought one syntax form and added a new place to be wrong. The rule now
lives in `packages/sdk/scripts/audit-browser-module.mjs`, which walks the TypeScript AST through the
same `typescript/unstable` API `@fairux/ast` parses with, and reaches template expressions the way
it reaches everything else. It refuses static Node builtin imports, dynamic `import()`, and bare
`require()` — the last two regardless of specifier, so nothing has to be extracted from them. Matching digests alone would
only show the bundle is self-consistent; a lifecycle script that rewrote the tarball and then
rewrote the metadata to match would pass identity checks and fail these.

Every script the publish job runs uses Node built-ins and `tar` only, so no dependency tree exists
while a token can be minted.

The CLI workflow has the same split. Its publish job keeps `contents: read`, because it creates no
GitHub Release.

Two things it does **not** do. It does not contact npm, so it cannot confirm that a matching
Trusted Publisher record exists — only a real publish proves that. And it saves no work: the
workflow is triggered by `push.tags`, so the tag already exists before any step runs, and the
unprivileged `prepare` job has already built, smoked, audited, and uploaded the artifact by the time
these checks run. What they prevent is an npm registry read or a publish attempt made with a
credential state that cannot work.

## Post-Publish Verification

After the workflow publishes, verify from the npm registry, not from a local tarball:

Name the registry on every one of these. `@fairux/sdk` is scoped, so npm consults
`@fairux:registry` before `registry`: a line in your own `.npmrc` would otherwise have you verifying
a different host than the one just published to, which proves nothing about the release. `--registry`
alone does not cover it — the scope key has to be set too.

```bash
NPM_SDK_REGISTRY_ARGS=(
  --registry=https://registry.npmjs.org/
  --@fairux:registry=https://registry.npmjs.org/
  --prefer-online
)

mkdir /tmp/fairux-sdk-registry-smoke
cd /tmp/fairux-sdk-registry-smoke
npm init -y
npm install @fairux/sdk@0.1.0-beta.2 "${NPM_SDK_REGISTRY_ARGS[@]}"
npm view @fairux/sdk@0.1.0-beta.2 version "${NPM_SDK_REGISTRY_ARGS[@]}"
npm view @fairux/sdk dist-tags "${NPM_SDK_REGISTRY_ARGS[@]}"
npm view @fairux/sdk@0.1.0-beta.2 dist.integrity "${NPM_SDK_REGISTRY_ARGS[@]}"
npm view @fairux/sdk@0.1.0-beta.2 dist.attestations "${NPM_SDK_REGISTRY_ARGS[@]}"
```

This applies to release verification, not to consumers: an ordinary `npm install @fairux/sdk` needs
none of it.

Then run the same root, HTML, DOM/browser bundle, custom RulePack, and TypeScript consumer checks
against the registry-installed package.

The reusable command pins both registry keys itself:

```bash
SDK_SPEC=@fairux/sdk@0.1.0-beta.2 \
EXPECTED_VERSION=0.1.0-beta.2 \
pnpm registry:smoke:sdk
```

Recorded for `@fairux/sdk@0.1.0-beta.2`, run by hand against the public registry after the release:

| | Node.js 22.18.0 | Node.js 24.11.0 |
| --- | --- | --- |
| npm | 10.9.3 | 11.6.1 |
| pnpm | 10.33.2 | 10.33.2 |
| Installed version | 0.1.0-beta.2 | 0.1.0-beta.2 |
| Registry | `https://registry.npmjs.org/`, both keys pinned | same |
| Checks | 23 passed, 0 failed | 23 passed, 0 failed |
| Exit status | 0 | 0 |

Each run installs into a fresh temporary directory with a cache directory of its own, from the
public registry with both keys pinned — no local tarball, no `workspace:` specifier, no path
dependency. The 23 checks cover the root import, `@fairux/sdk/html`, `@fairux/sdk/dom`, the browser
bundle and its execution against a DOM, the published TypeScript declarations, a custom RulePack,
external page contexts, and the rejection of an invalid RulePack.

The smoke is only evidence because it can fail. Before P20-T4, `runConsumerSmoke` returned a boolean
both callers ignored, so a `✗` line left the process exiting 0; the failed checks are now raised.
Negative control, on the published package:

```bash
SDK_SPEC=@fairux/sdk@0.1.0-beta.2 EXPECTED_VERSION=9.9.9 pnpm registry:smoke:sdk   # exits 1
```

P20 is not done until registry install, provenance or attestation, GitHub Release, and
post-publish smoke evidence are recorded.

## Build output contract

`pnpm check:build-output` is a release gate, not a tidiness check. It asserts that:

- **nothing at all** sits below a `dist` directory that is not a real workspace's own output
  directory. The allowed roots are discovered from the `package.json` manifests, not guessed from
  the path shape, so `packages/not-a-workspace/dist/`, `packages/core/src/dist/`, and `docs/dist/`
  are all refused — and refused whatever the file is, since a directory that is not a build
  directory cannot explain a `.json`, `.html`, or `.css` any better than a `.js`.
  `apps/chrome-extension` really does emit `manifest.json` and `popup.html`, so this is the
  difference between catching a mis-pointed copy step and not;
- no compiler or bundler output sits inside a source tree or anywhere else outside `dist/`, matched
  by suffix;
- a hand-written `.mjs` or `.d.mts` is allowed only when that exact path is already tracked in the
  Git index, inside an approved zone (`scripts/`, `packages|apps/<name>/scripts/`,
  `tests/fixtures/`), with no `dist` segment. Untracked means generated, whatever the extension.
  Failure to read the Git index aborts the check rather than falling back to trusting the
  filesystem;
- every package that declares `types` points that entry into its own `dist/` and ships the file;
- `@fairux/sdk` ships `dist/index`, `dist/html`, and `dist/dom` as both JS and declarations;
- the `fairux` CLI publishes no declarations, which is deliberate — it is an executable, not a
  typed library.

The gate does not lean on `git status`. `.gitignore` ignores `dist/` at any depth and `biome.json`
sets `vcs.useIgnoreFile`, so an artifact leaked into a `dist`-named directory appears in neither the
clean-worktree assertion nor the post-build lint. This check is the only signal that sees it, which
is why both allowances are decided from identities the gate discovers — real workspaces and tracked
paths — rather than from the shape of a path. It reads the Git **index** for source identity and
walks the **filesystem** for output, so an ignored untracked artifact is still found.

Fail-closed extends to the walk itself: a directory that is absent is fine, but any other
filesystem error aborts with the offending path rather than reading as "nothing to inspect".

The other half — one workspace reaching into another's private `src/`, the import that triggered
#57 — is enforced by TypeScript rather than by a script. Every package's `tsconfig.json` pins
`rootDir` to the workspace root and every `tsconfig.build.json` pins it to `src`. When a
TypeScript-resolved dependency pulls an emit-relevant foreign source file into one of those
projects, the repository-pinned compiler reports `TS6059` — during `pnpm typecheck`, and for
`test/` as well as `src/`, which is where the three original issue #57 imports lived.

The check evaluates the compiler's resolved program rather than matching source-like text. Strings,
comments, regular expressions, JSX text, and member calls do not become foreign program files, so
they cannot be reported. The contract is tested against the diagnostic itself, not against an exit
code, in `tests/unit/package-boundary-compiler.test.ts`.

Measured coverage: static imports, dynamic `import()`, `import x = require(…)`, and directory
imports each produce `TS6059`. A plain `require(…)` call does **not** — it is a runtime call rather
than a TypeScript module reference, so nothing enters the program to constrain. Every package here
is ESM, so such a call would not work at runtime either, but the contract does not cover it.

Both run in CI's `verify` job, and the build-output contract also runs in a dedicated
`build-output-contract` job that builds twice on Node.js 22.18.0 and 24.11.0 and diffs SHA-256
digests of every emitted artifact.

### Why this gates the release

Before P20-T3, `pnpm build` wrote 43 untracked `*.d.ts` files into `packages/core/src` and
`packages/rules/src` ([issue #57](https://github.com/toshtag/fairux-linter/issues/57)). Three tests
imported a sibling package by relative source path (`../../core/src/index.js`), and because each
package `tsconfig.json` includes `test`, those foreign sources entered the declaration program.
They sit outside the `--rootDir` that tsdown's tsgo generator is given, and tsgo writes
out-of-root declarations next to the source rather than into its temporary `--outDir`.

The consequences were release-shaped, not cosmetic: `pnpm lint` failed *after* a build, repeated
verification was non-idempotent, and a release-time write audit would have seen a dirty tree it
could not attribute.

The fix separates the two TypeScript contracts. `tsconfig.json` typechecks (`noEmit`) and includes
`test`; a per-package `tsconfig.build.json` scopes the declaration-emit program to `src` and owns
the emit options, and each `tsdown.config` points `dts` at it. Emitted `dist/` output is
byte-identical across the change, so no public declaration moved.

## Source Maps

The SDK beta tarball does not publish source maps. Release audit fails if `dist/*.map` files appear
in the tarball, and the source-map audit rejects embedded `sourcesContent`, absolute build-host
paths, repository paths, `packages/*/src`, `workspace:`, and `file://` sources.
