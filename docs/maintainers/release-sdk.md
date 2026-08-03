# SDK beta release runbook

This runbook governs the SDK release currently prepared in `packages/sdk/package.json`. It does not
authorize a publish by itself.

Every command in the active sections below derives its version, tag, and tarball name **from the
manifest** rather than naming one. A runbook that hard-codes the last release's version is a runbook
that tells the next maintainer to tag something already published — which is what happened here after
the bump to `0.1.0-beta.3`. Historical `beta.1` and `beta.2` records further down are deliberately
left as written: they are what happened, not what to do.

### SDK publication state

| Package version | npm state |
| --- | --- |
| `@fairux/sdk@0.1.0-beta.3` | **published** |

This table is the machine-checked record. `pnpm release:check:sdk` reads exactly one row from it and
requires the package and version to equal the SDK manifest's, so no prose anywhere can drift away
from the version being released. It sits in this runbook because this is where it is written: a
release bumps the manifest and this row in the same preparation PR.

`0.1.0-beta.3` reached the registry in
[run 30691990236](https://github.com/toshtag/fairux-linter/actions/runs/30691990236) from tag
`sdk-v0.1.0-beta.3`. `latest` still points at `0.0.0-bootstrap.0`; the beta is opt-in on `next`.
Measured evidence is in [Closeout evidence — 0.1.0-beta.3](#closeout-evidence--010-beta3).

## Released versions

| Version | Tag | Run | State |
| --- | --- | --- | --- |
| `0.1.0-beta.1` | `sdk-v0.1.0-beta.1` | [30233771956](https://github.com/toshtag/fairux-linter/actions/runs/30233771956) | **never published** — the registry `PUT` failed after the tag was consumed |
| `0.1.0-beta.2` | `sdk-v0.1.0-beta.2` | [30258382164](https://github.com/toshtag/fairux-linter/actions/runs/30258382164) | published on the third attempt, on `next` |
| `0.1.0-beta.3` | `sdk-v0.1.0-beta.3` | [30691990236](https://github.com/toshtag/fairux-linter/actions/runs/30691990236) | published on the first attempt, on `next` — see [Closeout evidence](#closeout-evidence--010-beta3) |

npm never lets a name/version pair be reused, so `0.1.0-beta.1` is permanently consumed. Each run's
own logs and the pull request that closed it out hold the rest; what the failures **changed** is in
the contracts below, which is where it can still be wrong.

## Release Automation

The SDK release is separate from the CLI release:

- CLI workflow: `.github/workflows/publish-cli.yml`, triggered by `v*` tags, version source
  `apps/cli/package.json`.
- SDK workflow: `.github/workflows/publish-sdk.yml`, triggered by `sdk-v*` tags, version source
  `packages/sdk/package.json`.

The tag is `sdk-v` followed by the manifest version — `sdk-v0.1.0-beta.2` was the first.

The SDK workflow packs the SDK tarball once:

```bash
pnpm --filter @fairux/sdk pack --pack-destination "$RUNNER_TEMP"
```

That same tarball is hashed, smoke-tested, audited, uploaded, published, and attached to the GitHub
Release.

## Local Preflight

Derive the release's identity from the manifest first, and use these variables everywhere below:

```bash
SDK_VERSION="$(node -p "require('./packages/sdk/package.json').version")"
SDK_TAG="sdk-v${SDK_VERSION}"
SDK_TARBALL="fairux-sdk-${SDK_VERSION}.tgz"
printf 'SDK_VERSION=%s\nSDK_TAG=%s\n' "$SDK_VERSION" "$SDK_TAG"
```

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
pnpm rules:catalog:check
pnpm pack:smoke
pnpm pack:smoke:sdk
pnpm release:check:sdk -- --tag "$SDK_TAG"
pnpm release:dry-run:sdk -- --tag "$SDK_TAG"
pnpm test:rule-pack-author-example
git diff --exit-code
test -z "$(git status --porcelain)"
```

The second `pnpm lint` and the closing worktree assertions are not padding. A release is only
reproducible if the build changes nothing outside `dist/`, so every step above must leave the tree
exactly as it found it — see [Build output contract](#build-output-contract).

`pnpm pack:smoke:sdk` also accepts an exact tarball contract used by the workflow:

```bash
TARBALL="/path/to/${SDK_TARBALL}" \
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
npx --yes npm@11.19.0 trust list @fairux/sdk \
  --json \
  --registry=https://registry.npmjs.org/
```

- `npm trust` requires **npm ≥ 11.15.0**; the npm shipped with this project's Node.js floors is
  older, hence `npx`. The version is **pinned exactly**, and to the same npm the registry signature
  audit uses (`SIGNATURE_AUDIT_NPM_VERSION` in `scripts/npm-signature-audit.mjs`). A range would let
  what this command reports change without anything here changing, which is the same reason the
  audit's verifier is pinned — two release-critical reads should not disagree about which npm
  performed them.
- **`--@fairux:registry` is not a flag this subcommand takes.** `npm trust list` accepts `--json` and
  `--registry` and nothing else; passing the scoped key fails with `EUSAGE Unknown flag`, which this
  document told owners to do until one of them ran it. The scope is not lost by leaving it off: the
  package is named explicitly, so `--registry` alone selects the host this one read asks. Every other
  npm command here still pins both keys — `install`, `view`, and `publish` resolve a scoped package
  through `@fairux:registry` first and fall back to `registry`, so for those, `--registry` alone
  leaves any `@fairux:registry=` line in an npmrc in charge of which host is asked. That reasoning is
  correct for those commands and does not transfer to a subcommand that rejects the flag.
- The first trust request may require **browser-based 2FA**. Do not record the authentication URL,
  the one-time password, or any token in a log, an issue, or a pull request.

npmjs.com → `@fairux/sdk` → Settings → Trusted Publisher shows the same values, and is the way to
change them. npm does not validate the record on save, so re-open the page afterwards and read the
stored values rather than trusting that the save succeeded.

## What the next version bump must carry

Two follow-ups are deliberately held until a version bump, because doing either alone would make the
repository disagree with metadata already on npm for `0.1.0-beta.2`.

- **The package description** ([issue #69](https://github.com/toshtag/fairux-linter/issues/69)).
  ✅ Published in `0.1.0-beta.3`: the bump and the narrowed description were in the same commit,
  because changing the description alone would make the manifest describe a version the registry
  describes differently. `npm view @fairux/sdk@0.1.0-beta.3 description` returns the narrowed
  string — the registry read-back, not the manifest edit, is what settles it. The Release notes'
  bounding paragraph no longer glosses the word "deterministic" — the description does not carry
  it — and states the shape of the guarantee on its own terms instead.
- **Nothing else.** `0.1.0-beta.2` is not re-published, re-tagged, or edited for either of these.

The release-notes honesty work from
[issue #83](https://github.com/toshtag/fairux-linter/issues/83) is **not** on this list — it landed
in the repository and applies to whatever is released next, with no bump required.

### Preparing and publishing the next SDK beta

**A release cannot start from the manifest version that is already published.** npm never lets a
name/version pair be reused, so the first step is a preparation PR that bumps
`packages/sdk/package.json`, records the exact new version as `unpublished` in
[SDK publication state](#sdk-publication-state) above, and passes [Local Preflight](#local-preflight).

Once that PR is merged and the exact commit is approved, follow
[Approval Boundary](#approval-boundary). It derives `SDK_VERSION` and `SDK_TAG` from the manifest and
performs the tag operation.

There is no tag command here on purpose. This subsection carried one twice: first naming a real
version, which became an instruction to tag an already-published release the moment it shipped, and
then a placeholder, which copies into a tag named after the placeholder itself. A second copy of the
tag command is a second thing to keep correct, and both copies were wrong before anyone read them.
The manifest is the one place the version lives.

The tag triggers `publish-sdk.yml`, which waits on the `publish` environment's required reviewer
before it can mint an OIDC token. Afterwards, follow **After the release** below.

`0.1.0-beta.3` was released this way; its measured evidence is in
[Closeout evidence — 0.1.0-beta.3](#closeout-evidence--010-beta3).

## How the notes decide what to claim

The generator used to emit "Published with npm Trusted Publishing over OIDC" from version-controlled
prose. Nothing ever supplied it a result proving that sentence, and the sentence stood for three
separate things at once — the authentication mechanism, the absence of long-lived credentials, and
the registry's provenance record — so an unverified claim rode along with verified ones.

They are three claims now, and two of them are conditional on flags the privileged job passes only
for steps that actually ran:

| Flag | Passed when | Without it |
| --- | --- | --- |
| `--verified-credential-preflight` | the no-npm-credential check ran and passed **before this run's first npm registry request** | the note says the workflow is *configured* that way and that the result is unverified |
| `--verified-provenance-attested` | `verify-sdk-provenance.mjs` read `dist.attestations` back and found an HTTPS URL with a SLSA provenance predicate | the note says `--provenance` was used and the read-back did not happen |

Each flag's meaning is deliberately narrower than the step it comes from.

The credential check also runs immediately before `npm publish`, but that second run is conditional
on `PUBLISH_NEEDED` — a rerun that finds the version already on the registry skips it — and there is
no check after publication at all. The notes once said "immediately before `npm publish` … and again
afterwards"; both halves were false for a rerun, while the flag was passed regardless. So the claim
is the one check that happens on every successful path.

The dist-tags are read back too, between the digest verification and the notes — and this is **two
checks, not one**.

*Current values*: `next` names this version, and neither `latest` nor `bootstrap` does. Necessary,
and not sufficient: a run where `latest` moved from `0.0.0-bootstrap.0` to some *other* release
passes it, because that other release is not the version being published.

*Before and after*: every tag except `next` is identical to a snapshot taken before the publish, none
was removed, and none appeared. The contract is **"this release was allowed to move `next` and
nothing else"**, and only a comparison can say that. The workflow captures the snapshot after the
credential preflight and before publishing, unconditionally — the rerun path is the only one where a
tag can have moved without this run moving it, so skipping the capture there would skip the case the
check exists for.

A missing, empty, or malformed snapshot fails the run. "Cannot compare" must never become "nothing
changed".

The workflow does not repair a mismatch; it stops. Moving a dist-tag is a publication decision. The digest check
verifies the *version*; the notes say `npm install @fairux/sdk@next`, which is a claim about the
**channel**. Those come apart on a rerun: the version is already present with a matching digest, the
publish is skipped, and `next` may have moved in between — so every digest check passes while the one
instruction a consumer follows is wrong. `verify-sdk-dist-tags.mjs` requires `next` to name this
version and requires `latest` and `bootstrap` **not** to, since a beta reaching `latest` is what
`npm install @fairux/sdk` hands someone who asked for nothing in particular. It repairs nothing:
moving a dist-tag is a publication decision, and a workflow that quietly re-pointed a channel would
be making one.

The provenance read-back reads metadata. It does not fetch the attestation bundle, verify a
signature, or bind the attestation to this workflow run or this commit — so the notes say what was
read and then say what was not, rather than describing what an attestation generally contains.
`npm audit signatures` against a clean registry install is the separate check that opens the bundle,
and it belongs to the registry-installed smoke.

The mechanism claim states only that the workflow is *configured* for Trusted Publishing over OIDC,
and explicitly declines to infer from that how a given version was published — pointing a reader at
`npm view`, which is the registry's own record rather than this document's.

There is no `--no-…` form. "The check ran and failed" is not a state these notes can describe: a
failed preflight or a missing attestation fails the job, so the only two states that reach the
generator are verified and not-reported. The flags are booleans, and a non-boolean is refused —
a truthy string standing in for a check that ran is precisely the confusion this closes.

## Beta-Only Policy

P20 is scoped to the SDK beta line. The `publish-sdk.yml` workflow refuses stable versions without a
prerelease marker and publishes with npm dist-tag `next`. Stable SDK release policy belongs in a
future task.

Release notes are generated from `packages/sdk/package.json` / `SDK_VERSION`; do not hard-code the
install version in workflow YAML.

## Approval Boundary

Without explicit owner release approval, do not create or push the release tag.

Owner approval authorizes **only** the annotated tag operation below. Do not run `npm publish`
manually, before or after approval. The tag-triggered `publish-sdk.yml` workflow owns publication,
the npm dist-tag update, provenance, the registry read-back, and GitHub Release creation — a manual
publish would produce a version with none of them, and npm never lets a name/version pair be reused,
so there is no second attempt to get it right.

This section used to open with a `do not run` block holding three commands: a lightweight tag, a
short-ref push, and a bare manual publish. Wrong commands are still commands. They sat above the
correct forms and contradicted them, they were the ones nearest the top and so the ones most likely
copied, and framing the manual publish as something approval unlocks was itself the error. What must
not be run is prose now; what may be run appears exactly once.

Re-derive the variables immediately before approval and assert them out loud, rather than trusting a
shell that has been open for an hour:

```bash
SDK_VERSION="$(node -p "require('./packages/sdk/package.json').version")"
SDK_TAG="sdk-v${SDK_VERSION}"
printf 'about to tag %s\n' "$SDK_TAG"
git ls-remote --tags origin "refs/tags/$SDK_TAG"   # must print nothing
```

Then, after approval, from a clean `main` at the approved commit:

```bash
git tag -a "$SDK_TAG" -m "@fairux/sdk ${SDK_VERSION}"
git push origin "refs/tags/$SDK_TAG"
```

Annotated, not lightweight: the tag object records who created it and when, which a release
reference should carry. Every ref here is the full `refs/tags/` path — including the existence
check, so that what is looked for and what is pushed are the same string — so a branch of the same
name can never be what actually matches or moves.

The PR may prepare automation and dry-run checks only. Public publication, GitHub Release creation,
and registry-installed smoke tests happen after approval and tag push.

## Privilege boundary

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

## What each job is responsible for

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

After the workflow publishes, verify from the npm registry, not from a local tarball.

**Derive the version first.** These commands used to name `0.1.0-beta.2` literally, which meant that
after a later release, following this runbook verified *the previous version* and went green — and
the one thing [#69](https://github.com/toshtag/fairux-linter/issues/69) closes on, the new
version's description, would never have been read at all.

```bash
SDK_VERSION="$(node -p "require('./packages/sdk/package.json').version")"
SDK_TAG="sdk-v${SDK_VERSION}"
SDK_SPEC="@fairux/sdk@${SDK_VERSION}"
printf 'verifying %s\n' "$SDK_SPEC"
```

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
npm install "$SDK_SPEC" "${NPM_SDK_REGISTRY_ARGS[@]}"
npm view "$SDK_SPEC" version "${NPM_SDK_REGISTRY_ARGS[@]}"
npm view "$SDK_SPEC" description "${NPM_SDK_REGISTRY_ARGS[@]}"
npm view "$SDK_SPEC" dist.shasum "${NPM_SDK_REGISTRY_ARGS[@]}"
npm view "$SDK_SPEC" dist.integrity "${NPM_SDK_REGISTRY_ARGS[@]}"
npm view "$SDK_SPEC" dist.attestations "${NPM_SDK_REGISTRY_ARGS[@]}"
npm view @fairux/sdk dist-tags --json "${NPM_SDK_REGISTRY_ARGS[@]}"
```

Expected, and each of these is a separate thing to look at rather than a glance:

| Read | Must be |
| --- | --- |
| `description` | `Public SDK facade for FairUX scanning and RulePack composition.` |
| `dist-tags.next` | `$SDK_VERSION` |
| `dist-tags.latest` | **not** `$SDK_VERSION` — the beta channel is opt-in |
| `dist.attestations` | present, with a SLSA provenance predicate |

The `description` read is what closes #69. It is listed here because a verification step that exists
only in an issue is a verification step that gets skipped.

This applies to release verification, not to consumers: an ordinary `npm install @fairux/sdk` needs
none of it.

Then run the same root, HTML, DOM/browser bundle, custom RulePack, TypeScript consumer, and
**registry signature** checks against the registry-installed package. The reusable command pins both
registry keys itself:

```bash
SDK_SPEC="$SDK_SPEC" \
EXPECTED_VERSION="$SDK_VERSION" \
pnpm registry:smoke:sdk
```

The smoke is only evidence because it can fail. Before P20-T4, `runConsumerSmoke` returned a boolean
both callers ignored, so a `✗` line left the process exiting 0; the failed checks are now raised.
Negative control, against whatever is published:

```bash
SDK_SPEC="$SDK_SPEC" EXPECTED_VERSION=9.9.9 pnpm registry:smoke:sdk   # exits 1
```

### Closeout evidence — 0.1.0-beta.3

Measured after [run 30691990236](https://github.com/toshtag/fairux-linter/actions/runs/30691990236)
completed, by reading the public registry and the published Release back. Every value below was read
from an external source after the fact; none is derived from the workflow's own log lines.

| | |
| --- | --- |
| Tag | `sdk-v0.1.0-beta.3` (annotated, `75b2228336f16fde5cf368d58716578808fe12a6`) → `853b0543c029ffe4a45db01424ffd6e04a9420d1` |
| Workflow run | [30691990236](https://github.com/toshtag/fairux-linter/actions/runs/30691990236) — one run, `success` on the first attempt |
| `publish` job | [91348276574](https://github.com/toshtag/fairux-linter/actions/runs/30691990236/job/91348276574), after the `publish` environment's required-reviewer approval |
| Registry publication | `@fairux/sdk@0.1.0-beta.3` on the `next` dist-tag |
| Description | `Public SDK facade for FairUX scanning and RulePack composition.` |
| `dist.shasum` | `3b22dcedb4e23c38877e36d49c2266e5032e140b` |
| `dist.integrity` | `sha512-8yafidGex0UP/+aa8JTHR7Kqrvy60+CzXcw9jjgRvv7nx1HPEAA6Riqybrog2nnnkIfKTOQGuxvjDJDOy5zAZg==` |
| `dist.unpackedSize` | 462241 |
| `dist.attestations` | `https://registry.npmjs.org/-/npm/v1/attestations/@fairux%2fsdk@0.1.0-beta.3`, predicate `https://slsa.dev/provenance/v1` |
| GitHub Release | [`sdk-v0.1.0-beta.3`](https://github.com/toshtag/fairux-linter/releases/tag/sdk-v0.1.0-beta.3), prerelease, not a draft, published 2026-08-01T08:41:23Z |
| Release assets | `fairux-sdk-0.1.0-beta.3.tgz` (113363 bytes), `release-sha256.txt` (94 bytes) |
| Deprecated | no |
| Issue [#69](https://github.com/toshtag/fairux-linter/issues/69) | resolved by this version; `npm view @fairux/sdk@0.1.0-beta.3 description` returns the narrowed string |

**Dist-tags, before and after.** The comparison this release path gained, run against the real
before-reading rather than against the current values alone:

| Tag | Before | After |
| --- | --- | --- |
| `next` | `0.1.0-beta.2` | `0.1.0-beta.3` |
| `latest` | `0.0.0-bootstrap.0` | `0.0.0-bootstrap.0` |
| `bootstrap` | `0.0.0-bootstrap.0` | `0.0.0-bootstrap.0` |

`verify-sdk-dist-tags.mjs --version 0.1.0-beta.3 --before-file <snapshot>` exits 0 against the live
registry: `next` names this version, no other tag names it, and every other tag is unchanged from
before the publish. A plain `npm install @fairux/sdk` still resolves `0.0.0-bootstrap.0`.

**One tarball, three byte sources, and one checksum record.** The first three rows are tarballs whose
bytes were hashed; the fourth is a value read out of a file, not that file's own digest:

| Source | SHA-256 |
| --- | --- |
| `fairux-sdk-tarball` workflow artifact, tarball bytes inside the zip | `6e5147a6bc3bc074f556fe31a4b7c539a91f29f6f0f430788f9193f3f741671f` |
| GitHub Release asset tarball bytes, downloaded | same |
| npm registry tarball bytes, downloaded | same |
| SHA-256 value recorded **in** `release-sha256.txt` | same |

The 94-byte `release-sha256.txt` asset is a `<sha256>  <filename>` line. Its own digest was not
measured and is not claimed here; listing it as though it were a fourth copy of the tarball would
assert something nobody checked.

GitHub's own digest for the `fairux-sdk-tarball` artifact —
`6c177e1a4821dfca90196488a8dd92528746523dbe2cf5b71baceec4c40fdc8b` — covers the **zip container**
Actions wraps an artifact in, not the tarball inside it. The two are not comparable, and reading the
first as a tarball digest would report a mismatch where there is none.

The registry's `dist.shasum` is the SHA-1 of that same downloaded tarball, and `dist.integrity`
decodes to its SHA-512. The SLSA provenance attestation's subject digest is that SHA-512, so the
attestation names the bytes npm serves.

**Two different checks, at two different times.** The privileged publish job's read-back is metadata
only: it asked the registry whether `dist.attestations` exists, carries an HTTPS URL, and names a
SLSA provenance predicate. It did not fetch the Sigstore bundle and did not verify anything
cryptographically, which is the limit the Release notes state.

The registry-installed smoke below is the separate, later check, and it does verify. Pinned npm
11.19.0's `npm audit signatures --include-attestations` verified the registry signature and the
provenance attestation for this exact version against the public registry, failing on a missing or
invalid one. Reading the metadata check's limit as though it applied to the audit — "the bundle was
never verified" — would contradict the smoke results recorded two paragraphs down, in the same
section.

What this repository did **not** do is assert, as a check of its own, that the verified provenance
statement's source and build fields name run 30691990236, commit `853b0543…`, or
`publish-sdk.yml` at `refs/tags/sdk-v0.1.0-beta.3`. The subject digest binds the attestation to the
bytes npm served; binding it to the expected build identity is a further assertion, and no step here
makes it.

**Registry-installed smoke, both Node floors.** `pnpm registry:smoke:sdk` against
`@fairux/sdk@0.1.0-beta.3`:

| | Node.js 22.18.0 | Node.js 24.11.0 |
| --- | --- | --- |
| Exit status | 0 | 0 |
| Signature audit npm | 11.19.0 | 11.19.0 |
| `npm audit signatures --include-attestations` | verified, SLSA provenance, against `https://registry.npmjs.org/` | same |
| Consumer checks | 20 passed, 0 failed | 20 passed, 0 failed |

The checks covered the root import, `@fairux/sdk/html`, `@fairux/sdk/dom`, RulePack composition and
its immutability, external page contexts, the rejection of a malformed pack, the published
TypeScript declarations, and the browser bundle's size and execution against a DOM.

**No fallback.** An independent `npm install` into an empty directory outside this repository, with
a cache directory of its own, resolved
`https://registry.npmjs.org/@fairux/sdk/-/sdk-0.1.0-beta.3.tgz` with an `integrity` identical to the
registry's `dist.integrity`. `node_modules/@fairux/sdk` is a real directory rather than a symlink,
and the lockfile contains no `file:` or `link:` specifier — so no workspace link, no pnpm store, and
no local tarball took part.

## Correcting a published Release

A Release's title and body can be wrong while its artifact is right — [issue #63](https://github.com/toshtag/fairux-linter/issues/63)
was that, for `sdk-v0.1.0-beta.2`: the generator's output at the time was a flat bullet list saying
"Install after publication" of an already-published package, naming an exact version instead of the
`next` channel.

**The correction edits the existing Release rather than rerunning the workflow.** A rerun re-uploads
both assets with `--clobber` and changes their identity for a presentation fix. This procedure ran
once, on 2026-07-28, and its verified result — including the manual rendering check — is in
[PR #71](https://github.com/toshtag/fairux-linter/pull/71). It is written out here because the parts
that make it safe are not obvious, and the next one will need them.

This runs on a maintainer's machine, not on a runner, so it makes its own scratch directory.
`$RUNNER_TEMP` is unset outside Actions, and `--out "$RUNNER_TEMP/sdk-release-notes.md"` would
expand to `/sdk-release-notes.md` — a write at the filesystem root.

One block, and it stops on the first failure. `set -euo pipefail` is the contract: a prose
instruction to "stop if this fails" is not one, and a `git fetch` that fails would otherwise leave
the next command reading whatever the working copy already had.

Both GitHub reads and the single write name the host and the repository. `gh` resolves an
unqualified command through `GH_HOST`, `GH_REPO`, and the current directory's remotes, so pinning
npm to the public registry while leaving the *write* target to the environment would be the wrong way
round.

**First, write down what you expect the Release to be.** `check-sdk-release-state.mjs` takes it as
a `--expected` JSON file rather than carrying it: a gate hard-coded to one release can only ever
guard that release. Read the values off the Release and the registry, and write them where you can
be held to them:

```jsonc
{
  "tag": "sdk-v0.1.0-beta.2",
  "targetCommitish": "main",          // the branch the Release records, not the source commit
  "tagCommit": "516b2473a7adaa24dd250ec20f916cf53bd9fa28",
  "tagRefObject": "35cdf68278afb864a1e01ebdc4250ba197c5f797",  // annotated tags only
  "title": "@fairux/sdk 0.1.0-beta.2",
  "prerelease": true,
  "draft": false,
  "assets": [{ "id": 0, "name": "…", "size": 0, "digest": "sha256:…", "content_type": "…" }],
  "npm": { "version": "…", "shasum": "…", "integrity": "sha512-…", "tarball": "https://…",
           "fileCount": 0, "unpackedSize": 0 },
  "distTags": { "next": "…", "latest": "…", "bootstrap": "…" }
}
```

Every field is required and the run stops before it compares anything if one is missing. That is
not pedantry: the first version of this checker compared the fields it was given and said nothing
about the ones it was not, so a capture with empty assets and a `latest` pointing at `evil-version`
printed three ticks and exited 0. An expectation supplied as a file is input, and input is exactly
what that version trusted.

**Then capture the external state and check it against the expectation.** Comparing before against
after proves only that the edit changed nothing; it says nothing about whether the Release was
already what it should be. Both questions have to be asked, and this one first.

```bash
set -euo pipefail

readonly GITHUB_HOST="github.com"
readonly GITHUB_REPOSITORY="github.com/toshtag/fairux-linter"
readonly GITHUB_API_REPOSITORY="repos/toshtag/fairux-linter"
readonly RELEASE_TAG="sdk-v0.1.0-beta.2"
readonly RELEASE_TITLE='@fairux/sdk 0.1.0-beta.2'
readonly RELEASE_COMMIT="516b2473a7adaa24dd250ec20f916cf53bd9fa28"
readonly EXPECTED_STATE="./expected-release-state.json"   # the file written above

NPM_SDK_REGISTRY_ARGS=(
  --registry=https://registry.npmjs.org/
  --@fairux:registry=https://registry.npmjs.org/
  --prefer-online
)

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

# --- capture, before anything is edited -------------------------------------------------------
gh api --hostname "$GITHUB_HOST" \
  "$GITHUB_API_REPOSITORY/releases/tags/$RELEASE_TAG" \
  > "$work/release-before.json"

gh api --hostname "$GITHUB_HOST" \
  "$GITHUB_API_REPOSITORY/git/ref/tags/$RELEASE_TAG" \
  > "$work/tag-ref-before.json"

# `sdk-v0.1.0-beta.2` is an annotated tag: the ref names a tag object, and only its dereference
# names the commit. Reading `object.sha` from the ref alone compares a tag object to a commit.
tag_object=$(jq -r '.object.sha' "$work/tag-ref-before.json")
gh api --hostname "$GITHUB_HOST" \
  "$GITHUB_API_REPOSITORY/git/tags/$tag_object" \
  > "$work/tag-object-before.json"

npm view "@fairux/sdk@0.1.0-beta.2" --json \
  --cache "$work/npm-cache-before" \
  "${NPM_SDK_REGISTRY_ARGS[@]}" \
  > "$work/npm-before.json"
npm view @fairux/sdk dist-tags --json \
  --cache "$work/npm-cache-before" \
  "${NPM_SDK_REGISTRY_ARGS[@]}" \
  > "$work/dist-tags-before.json"

node scripts/check-sdk-release-state.mjs \
  --expected "$EXPECTED_STATE" \
  --release "$work/release-before.json" \
  --npm "$work/npm-before.json" \
  --dist-tags "$work/dist-tags-before.json" \
  --tag-ref "$work/tag-ref-before.json" \
  --tag-object "$work/tag-object-before.json"

# --- the manifest that shipped, from the commit the tag resolves to ---------------------------
git fetch --force --no-tags \
  "https://$GITHUB_REPOSITORY.git" \
  "refs/tags/$RELEASE_TAG"
release_target=$(git rev-parse "FETCH_HEAD^{commit}")

verified_commit=$(jq -r '.object.sha' "$work/tag-object-before.json")
if [ "$release_target" != "$verified_commit" ] || [ "$release_target" != "$RELEASE_COMMIT" ]; then
  echo "ERROR: fetched tag, GitHub tag ref, and expected commit disagree" >&2
  exit 1
fi

git show "$release_target:packages/sdk/package.json" > "$work/package.json"

node packages/sdk/scripts/release-notes.mjs \
  --package-json "$work/package.json" \
  --tag "$RELEASE_TAG" \
  --source-commit "$release_target" \
  --dist-tag next \
  --tarball fairux-sdk-0.1.0-beta.2.tgz \
  --checksum release-sha256.txt \
  --out "$work/sdk-release-notes.md"

# --- the only write ---------------------------------------------------------------------------
gh release edit "$RELEASE_TAG" \
  --repo "$GITHUB_REPOSITORY" \
  --title "$RELEASE_TITLE" \
  --notes-file "$work/sdk-release-notes.md" \
  --prerelease

# --- capture again, and compare ----------------------------------------------------------------
gh api --hostname "$GITHUB_HOST" \
  "$GITHUB_API_REPOSITORY/releases/tags/$RELEASE_TAG" \
  > "$work/release-after.json"
gh api --hostname "$GITHUB_HOST" \
  "$GITHUB_API_REPOSITORY/git/ref/tags/$RELEASE_TAG" \
  > "$work/tag-ref-after.json"
gh api --hostname "$GITHUB_HOST" \
  "$GITHUB_API_REPOSITORY/git/tags/$(jq -r '.object.sha' "$work/tag-ref-after.json")" \
  > "$work/tag-object-after.json"

npm view "@fairux/sdk@0.1.0-beta.2" --json \
  --cache "$work/npm-cache-after" \
  "${NPM_SDK_REGISTRY_ARGS[@]}" \
  > "$work/npm-after.json"
npm view @fairux/sdk dist-tags --json \
  --cache "$work/npm-cache-after" \
  "${NPM_SDK_REGISTRY_ARGS[@]}" \
  > "$work/dist-tags-after.json"

node scripts/check-sdk-release-state.mjs \
  --expected "$EXPECTED_STATE" \
  --release "$work/release-after.json" \
  --npm "$work/npm-after.json" \
  --dist-tags "$work/dist-tags-after.json" \
  --tag-ref "$work/tag-ref-after.json" \
  --tag-object "$work/tag-object-after.json" \
  --before "$work/release-before.json" \
  --npm-before "$work/npm-before.json" \
  --dist-tags-before "$work/dist-tags-before.json" \
  --tag-ref-before "$work/tag-ref-before.json" \
  --tag-object-before "$work/tag-object-before.json" \
  --body "$work/sdk-release-notes.md"
```

`check-sdk-release-state.mjs` fails unless every one of these is present **and** equal to the
recorded value: the tag, `target_commitish`, `prerelease`, `draft`, both asset names with their
`id`, `size`, `digest`, and `content_type`, npm's `version`, `dist.shasum`, `dist.integrity`,
`dist.tarball`, `dist.fileCount`, and `dist.unpackedSize`, the whole dist-tag map with no extra
channel, and the tag ref with its dereferenced commit. Absence is a failure rather than a match: an
earlier version compared only the fields it was handed, and passed a capture whose assets carried
nothing but names.

On the second run it additionally compares the enumerated immutable projection between the two
captures, and checks the **corrected presentation** — the published title against
`@fairux/sdk 0.1.0-beta.2`, and the published body against the generated file. The `--title` in the
command above is what was asked for; only this says what the Release now carries.

The projection is a listed set, not everything GitHub returns. It covers the Release's `tag_name`,
`target_commitish`, `prerelease`, `draft`, and each asset's `id`, `name`, `size`, `digest`, and
`content_type` — each already required to be present, so a field missing from both captures cannot
compare equal — plus npm's `version`, `dist.shasum`, `dist.integrity`, `dist.tarball`,
`dist.fileCount`, and `dist.unpackedSize`, the `next`, `latest`, and `bootstrap` dist-tags, and the
tag ref. The Release's `id`, `node_id`, `created_at`, `published_at`, `author`, and URL fields are
outside it and are not established here. `name` and `body` are excluded deliberately: they are what
the edit changes, and the presentation check is what constrains them.

The body comparison is exact source-text equality after folding CRLF to LF — and only CRLF. A
carriage return that is not part of a CRLF pair is a failure rather than something to strip;
removing every `\r` made `ab\rc` equal `abc`. Nothing else is normalised, since a trim would hide
exactly the trailing-newline drift the generator's contract exists to pin. It compares decoded
strings from a JSON response, not raw bytes, and it says nothing about how GitHub renders that
Markdown; a rendering check is a separate, manual step and is recorded as one.

Both the manifest-derived facts and `--source-commit` come from the commit resolved from the
existing Release tag, not from the Release API's `target_commitish` branch — that field holds
`main`, and the distinction is the whole point of resolving through the tag. The current `main`
manifest is not used to describe an older artifact: the description, Node engines,
public entry points, and repository URL in the body must be the ones that shipped, and today's
agreement between the two manifests is a coincidence this procedure does not rely on.

The intended presentation changes are the Release `name` and `body`; GitHub also updates
`updated_at`. The automated evidence establishes the corrected presentation and the enumerated
immutable projection above — tag name, target commitish, `prerelease`, `draft`, every asset's id,
name, size, digest, and content type, the npm version, `dist.shasum`, `dist.integrity`,
`dist.tarball`, `fileCount`, `unpackedSize`, the `next`, `latest`, and `bootstrap` dist-tags, and
the tag ref through to its dereferenced commit. It does not establish unlisted GitHub API fields.
`gh release upload`, `gh release delete`, `npm publish`, and `npm dist-tag` have no part in this
procedure. A mismatch on anything the check does cover is a stop, not a note.

### Manual presentation check

The machine checks compare source text. Nothing above looks at how GitHub renders that Markdown, so
that is a separate step with a separate record. After the checks pass, open the published Release
and confirm:

- the nine `##` sections render as separate headings;
- the install command renders as a fenced code block;
- the public entry point and asset tables render as tables;
- each documentation link opens the intended file in this repository;
- no Markdown source is left visibly exposed as malformed structure.

Record it as manual presentation evidence with the observer, the time checked, the Release URL, and
the result. It is not produced by `check-sdk-release-state.mjs` and is not a machine assertion; do
not report it as one.

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
