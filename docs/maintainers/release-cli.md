# FairUX CLI release runbook

How the `fairux` CLI gets to npm, and what has to be true first.

The external prerequisites are owner actions on npmjs.com and no amount of repository work can
satisfy them, so this document is where they are written down — the first tag push is not the place
to discover them.

The opening paragraph here used to say:

> Nothing here has been executed. `fairux` is not on npm, no `v*` tag exists, and no GitHub Release
> for the CLI exists.

That was true when it was written and false from the first beta onward, while the same document
recorded two published releases further down. What is published, and what was measured after each
publication, is in [After the release](#after-the-release) rather than in a sentence at the top that
nothing checks.

## Publication contract

| Property | Value |
| --- | --- |
| Package | `fairux` (unscoped, public) |
| Version source | `apps/cli/package.json` |
| Git tag | `v` followed by the manifest version |
| npm dist-tag | derived from the version: `latest` for a stable release, `next` for a prerelease |
| Bootstrap placeholder | `0.0.0-bootstrap.0` on the `bootstrap` dist-tag |
| `latest` | the `0.0.0-bootstrap.0` placeholder, until the first stable release moves it |
| Workflow | `.github/workflows/publish-cli.yml` |
| GitHub environment | `publish` |

Dist-tag rules, enforced by `apps/cli/scripts/cli-dist-tag-contract.mjs`:

- A prerelease never goes to `latest`, and a stable release never goes to `next`.
- The bootstrap placeholder never goes to either, and is never published by the workflow.
- **A channel may advance and must not go backwards.** Before publishing `X`, the channel it
  publishes to must be absent or name a version older than `X` by SemVer precedence. Naming `X`
  itself, naming something newer, or naming something of the wrong kind stops the run.
- `latest` is checked when a prerelease is published too, because `next` must not fall behind the
  version a plain install resolves. Before the first stable release that means `latest` holds the
  bootstrap placeholder; afterwards it means `latest` holds an older stable release. A `latest`
  holding a beta, or any other prerelease, stops the run.
- `next` must name exactly the version the run published, read back after the publish.
- The workflow creates, moves, and removes no dist-tag. `npm publish --tag next` does not touch
  `latest`, so a `latest` that is wrong is a fact nobody in this repository produced deliberately —
  and rewriting registry state to make a check pass is not a fix.

### Why `latest` holds the placeholder, and why nobody should try to change that

This table used to say `latest` was **absent** before the first stable release, on the argument that
absence stops `npm install fairux` resolving a beta without also advertising a version nobody should
install. npm does not permit that policy, and the preflight found it by refusing the first beta over
a state no owner could reach:

- **npm sets `latest` on a package's first publish**, whatever `--tag` says. `--tag bootstrap` puts
  the placeholder on `bootstrap`; it does not stop the first version of a new package becoming the
  default one.
- **`npm dist-tag rm fairux latest` is refused with HTTP 400.** npm does not let a package be left
  with no default.

So `fairux` and `@fairux/sdk` sit in the same place, and it is the correct place:

```text
bootstrap: 0.0.0-bootstrap.0
latest:    0.0.0-bootstrap.0
```

**Do not try to remove it.** What stops the placeholder being installed by accident is
`npm deprecate`, which the bootstrap step below runs: an install prints the notice pointing at
`fairux@next`. The first stable release is what moves `latest`, and until then every beta leaves it
alone.

Concretely, for the releases this repository can foresee:

| Publishing | `next` before | `latest` before | Verdict |
| --- | --- | --- | --- |
| `0.1.0-beta.1` | absent | `0.0.0-bootstrap.0` | first beta |
| `0.1.0-beta.2` | `0.1.0-beta.1` | `0.0.0-bootstrap.0` | `next` advances; `latest` is untouched |
| `0.1.0` | `0.1.0-rc.1` | `0.0.0-bootstrap.0` | first stable; it moves `latest`, and `next` is left where it is |
| `0.2.0-beta.1` | `0.1.0-rc.1` | `0.1.0` | prerelease after a stable release |
| `0.1.0-beta.1` | `0.1.0-beta.2` | any | refused — the channel would move backwards |
| `0.2.0-beta.1` | any | `0.1.0-beta.9` | refused — `latest` holds a prerelease |
| `1.0.0-beta.1` | any | `1.0.0` | refused — `latest` has already overtaken it |

## The release's identity

Every command below derives the version, tag, and spec from the manifest. Set them once:

```bash
CLI_VERSION="$(node -p "require('./apps/cli/package.json').version")"
CLI_TAG="v${CLI_VERSION}"
CLI_SPEC="fairux@${CLI_VERSION}"
printf 'CLI_VERSION=%s\nCLI_TAG=%s\n' "$CLI_VERSION" "$CLI_TAG"
```

A runbook that writes the version out instead tells the next maintainer to tag something already
published, the moment the first release ships. That happened to the SDK's runbook, which still said
`--tag sdk-v0.1.0-beta.2` after the bump to `beta.3` — a release check that fails, and one
irreversible command that does not.

## External Configuration Checklist

Repository owners must complete these before pushing the release tag:

- npm account ownership of the unscoped name `fairux`;
- the bootstrap publish below, which creates the package;
- npm Trusted Publisher configured for `fairux`, with the exact field values below;
- npm package access is public;
- GitHub `publish` environment exists, with its protection rules and reviewer intentional;
- release approver has reviewed the exact commit on `main`;
- the version in `apps/cli/package.json` is not already present on npm.

Do not add an npm token secret as a workaround. The intended release path is Trusted Publishing via
OIDC provenance, and `scripts/check-trusted-publishing.mjs` refuses to publish if a credential is
present in the job environment or in any npm config the job can see.

## Bootstrap publish

This is the one step that must be done by hand, once, and it is a prerequisite for everything else.

npm's Trusted Publisher record is configured on a package's own settings page. A package that does
not exist has no settings page, so the name has to be created before OIDC publishing can be
configured for it. `@fairux/sdk` shows the same shape on the registry today: a `0.0.0-bootstrap.0`
under a `bootstrap` dist-tag, which no beta release path produces.

The owner performs this locally or in an isolated environment. **It is not part of any workflow, and
`publish-cli.yml` refuses a bootstrap version if one is ever tagged** — the placeholder is a
well-formed prerelease, so the repository-wide "prerelease is next" policy would otherwise route it
straight onto the beta channel.

### 1. Build the placeholder outside this repository

Do not change `apps/cli/package.json` to pack it. The placeholder is a different package from the
CLI and shares nothing with it but a name.

```bash
BOOTSTRAP_DIR="$(mktemp -d)"
cd "$BOOTSTRAP_DIR"

cat > package.json <<'JSON'
{
  "name": "fairux",
  "version": "0.0.0-bootstrap.0",
  "description": "Bootstrap placeholder reserving the fairux package name for the FairUX CLI.",
  "license": "Apache-2.0",
  "repository": {
    "type": "git",
    "url": "git+https://github.com/toshtag/fairux-linter.git"
  }
}
JSON

cat > README.md <<'MD'
# fairux bootstrap placeholder

This version only reserves the package name for the FairUX CLI release
workflow. Do not install it as the CLI.

Use `fairux@next` after the first beta has been published.
MD

npm pack --json
```

Inspect what it would publish before publishing it:

```bash
tar -tzf fairux-0.0.0-bootstrap.0.tgz
shasum -a 256 fairux-0.0.0-bootstrap.0.tgz
```

### 2. Publish it

```bash
npm publish \
  --registry=https://registry.npmjs.org/ \
  --access public \
  --tag bootstrap \
  ./fairux-0.0.0-bootstrap.0.tgz
```

`--tag bootstrap` is not optional. Without it npm uses `latest`, which is the one channel this
contract wants empty.

### 3. Read back what the registry actually did

```bash
npm view fairux@0.0.0-bootstrap.0 \
  version dist.shasum dist.integrity \
  --registry=https://registry.npmjs.org/ \
  --json

npm view fairux dist-tags \
  --registry=https://registry.npmjs.org/ \
  --json
```

Expected:

```text
bootstrap: 0.0.0-bootstrap.0
latest:    0.0.0-bootstrap.0
next:      absent
```

**`latest` on the placeholder is correct, and is not something to fix.** npm sets it when a package
is first published, whatever `--tag` says, and refuses `npm dist-tag rm fairux latest` with HTTP
400. `@fairux/sdk` shows the same two lines. See
[why `latest` holds the placeholder](#why-latest-holds-the-placeholder-and-why-nobody-should-try-to-change-that).

The next step is what keeps it from being installed by accident. Mark the placeholder so nobody
installs it in passing:

```bash
npm deprecate \
  'fairux@0.0.0-bootstrap.0' \
  'Bootstrap placeholder only. Install fairux@next after the beta release.'
```

Read step 3's output before moving on. Once `fairux@0.0.0-bootstrap.0` has been published, that
exact name and version can never be reused — not even after an unpublish. Unpublishing itself is
not impossible after 72 hours, but it is conditional on npm's policy criteria (no dependents, few
recent downloads, a sole owner), which is a different and much weaker guarantee than "you can undo
this".

## Trusted Publisher

### Trusted Publisher record — exact field values

On npmjs.com, under `fairux` → Settings → Trusted Publisher:

| Field | Value |
| --- | --- |
| Provider | GitHub Actions |
| Organization or user | `toshtag` |
| Repository | `fairux-linter` |
| Workflow filename | `publish-cli.yml` |
| Environment name | `publish` |
| Allowed actions | `npm publish` |

**The workflow filename is a basename, not a path.** npm's field is "the filename of your workflow";
`.github/workflows/publish-cli.yml` is not a value npm will ever match. npm does not validate the
record when it is saved, so a path is accepted at save time and could only fail at publish — with
`ENEEDAUTH`, which reads as "you are not logged in" rather than "this record does not match". The
SDK's first release attempt failed with exactly that error; see
[the SDK runbook](release-sdk.md) for what is and is not established about the connection.

After saving, add no npm token to the workflow. `NODE_AUTH_TOKEN`, a `_authToken` line, or an
`actions/setup-node` `registry-url` input would each suppress or bypass the OIDC exchange, and the
preflight refuses to publish when it finds one.

### Reading the record

The record lives on npm. Nothing in this repository can read it — this is a check the owner
performs, and the values above are what they check against.

```bash
npx --yes npm@^11.15.0 trust list fairux \
  --json \
  --registry=https://registry.npmjs.org/
```

- `npm trust` requires **npm ≥ 11.15.0**; the npm shipped with this project's Node.js floors is
  older, hence `npx`.
- One registry key, not two: `fairux` is unscoped, so there is no `@fairux:registry` for npm to
  resolve first. The SDK's read pins both because a scoped package resolves through the scope key
  before it falls back to `registry`.
- The first trust request may require **browser-based 2FA**. Do not record the authentication URL,
  the one-time password, or any token in a log, an issue, or a pull request.

**An `EOTP` from this command is not evidence the record is missing.** It says npm wants a one-time
password for the read, and nothing about what is stored. The record is read back on npmjs.com's own
settings page, by the owner, after saving; that read-back is the evidence, and the publish workflow's
OIDC exchange is what proves it end to end. Automation that treated `EOTP` as "not configured" would
be reporting its own lack of a credential as a fact about the registry, and no repository check may
conclude that.

npmjs.com → `fairux` → Settings → Trusted Publisher shows the same values, and is the way to change
them. npm does not validate the record on save, so re-open the page afterwards and read the stored
values rather than trusting that the save succeeded.

## Rehearsing the release

Everything except the registry runs locally, and after every merge in `release-contract.yml`:

```bash
pnpm release:check:cli -- --tag "$CLI_TAG"
pnpm release:dry-run:cli -- --tag "$CLI_TAG"
```

The dry run packs once, smokes the exact tarball, audits those bytes against the release contract,
renders the release notes through the same invocation the workflow uses, and runs
`npm publish --dry-run`. `cli-release-preflight` runs it on every push to `main`, and on demand
from the Actions tab, on Node.js 22.18.0 and 24.11.0.

It reads no registry. `fairux` is absent from npm, so every read of it is an `E404`; that is the
correct external state, not something to assert around. The publication plan's own logic is covered
by `tests/unit/cli-registry-plan.test.ts` with injected readers.

## Platform coverage of the packed CLI

`pnpm pack:smoke` packs the CLI, audits the archive, installs it into a clean project, and runs the
published CLI's behaviour contract through the executable npm generated for it — `fairux` on POSIX,
`fairux.cmd` on Windows. `pack-smoke` runs it on `ubuntu-latest` and `pack-smoke-windows` on
`windows-latest`, each on Node.js 22.18.0 and 24.11.0.

Both platforms run the same two modules, which is the point rather than an implementation detail:

- `apps/cli/scripts/packed-tarball-contract.mjs` — what the archive may contain. The privileged
  publish job re-runs it against the downloaded bundle.
- `apps/cli/scripts/installed-cli-smoke-contract.mjs` — what an installed `fairux` must do:
  identity, the HTML/JSX/TSX adapters, stdin/file/directory/glob targets, Markdown/JSON/SARIF
  output, config auto-discovery, an explicit trusted config, and exit codes 0/1/2. It takes an
  already-installed CLI, so the registry-installed smoke (M1-R4) runs the same expectations against
  a CLI that came from npm rather than from a local tarball.

A Windows-only or registry-only variant of these checks would be a second contract that drifts from
the first, so there is not one. `config-windows` remains: it covers config identity and path
semantics from the workspace, where a failure is attributable to a source file.

The Windows job additionally runs the runner and bin-resolution cases that only mean something on
that platform — launching a real `.cmd` through `cmd.exe`, the quoting rule that goes with it, and
`PATHEXT` resolution — and grants only `contents: read`.

The glob case runs both separator forms. `inputs/*.html` is checked everywhere; on Windows
`inputs\*.html` is checked beside it and must name exactly the same files. The native form matched
nothing until [issue #84](https://github.com/toshtag/fairux-linter/issues/84), and pinning only the
portable form here would have handed that gap to the registry-installed smoke as the supported
behaviour.

## Registry-installed coverage

`pnpm registry:smoke:cli` is the same behaviour contract against a CLI that came from npm.
`CLI_SPEC` and `EXPECTED_VERSION` name one exact version; the smoke installs it into a clean temp
project with its own npm cache and runs `installed-cli-smoke-contract.mjs` through the executable
npm generated. The packed smoke and this one differ in provenance and in nothing else — a packed
tarball never went through npm's publish pipeline, was never stored or served by the registry, and
carries no dist-tag.

What is checked here and nowhere else:

- The registry is read *before* the install, so an unpublished `fairux` says so in one line instead
  of surfacing a 404 from inside `npm install`. `absent` and `unavailable` stay distinct.
- The installed manifest's version must equal the resolved one, so a dist-tag that moved between
  resolving and installing cannot let a run pass under the resolved version's name.
- `npm audit signatures --json --include-attestations` must report `fairux` as verified, at the
  expected version, against `https://registry.npmjs.org/`, carrying a SLSA provenance predicate.
  This is the independent half of the provenance claim: the publish workflow reads back that npm
  *reports* attestation metadata, which is an API response read by the process that wrote it. An
  invalid signature anywhere in the tree fails the run; a dependency that merely carries no
  attestation does not, since that is its own maintainer's publish choice.

`.github/workflows/registry-cli-smoke.yml` runs it weekly and on dispatch, resolving `fairux@next`
to an exact version with `apps/cli/scripts/npm-registry-state.mjs` and validating it as strict
SemVer before it reaches `GITHUB_ENV`. Four cells: `ubuntu-latest` and `windows-latest`, on Node.js
22.18.0 and 24.11.0. `contents: read`, no `id-token`, no secret, and not a required check — it
observes the public registry, so a registry incident must not block unrelated pull requests.

**It has never run green, and cannot until `fairux` is published.** Every run reports
`fairux@next is absent on the public registry` and fails. That is the accurate state and is
deliberately not hidden behind a conditional: a canary that passes while there is nothing to
observe is worse than one that reports the absence. Its first meaningful run is the one after the
first publish, and it belongs in the post-release checks below rather than in the pre-release
checklist as evidence.

## Where a Release may land, and what must be there afterwards

Two boundaries the publish path did not close, both of which fail quietly:

- **`gh` resolves its target from the environment.** `GH_REPO` wins over the checkout's remote, so an
  inherited value — from a composite action, a reusable workflow, an organisation variable — would
  send `gh release create` at a different repository while every other check in the run passed.
  `scripts/check-release-target.mjs` runs **before** any `gh release` write in both publish
  workflows and refuses a `GH_REPO` naming anything else, a `GH_HOST` or enterprise token at all, and
  a `GITHUB_REPOSITORY` that is not `toshtag/fairux-linter` — the last one catches a fork or a
  rename.
- **A Release was never read back.** The workflow uploaded assets and stopped. "The bytes were handed
  to GitHub" is strictly weaker than "these bytes are what GitHub serves", which is the distinction
  the registry half already makes by re-reading the published digest.
  `scripts/verify-published-release.mjs` runs **after** the write: it re-downloads every asset,
  hashes it, and compares against the bundle this run audited. Not against the API's own digest
  field — a field the publisher never re-downloads is a claim about an API response, and a consumer
  downloads bytes.

It also refuses a draft, a Release on another tag, an asset still mid-upload, and an asset this run
did not upload — the last being either a leftover from a superseded attempt or something nobody in
this run put there.

### Immutable Releases: decided not to enable

GitHub's Immutable Releases fix a Release's assets and tag after publication. That is incompatible
with the rerunnable create-or-repair contract M1-R2 built deliberately, and
[issue #82](https://github.com/toshtag/fairux-linter/issues/82) recorded that the two cannot both
stand.

**They stay off.** The rerunnable path exists because a real failure happened: a successful npm
publish was recorded as a failed release, and the ability to rerun and repair the Release without
touching the published package is what makes that recoverable. Immutability would buy tamper-evidence
after publication and cost recoverability before it — and the tamper-evidence is already covered by
the read-back above, which proves the served bytes are the audited bytes rather than merely
preventing a later change.

This is a decision, not a permanent property. Enabling them later means replacing create-or-repair
with a draft-first flow — create the draft, attach every asset, verify, then publish once — and the
contract module is shaped so that verification step is already written.

## Pre-release checklist

Before the tag is pushed:

Which channel this release moves decides two of these, so derive it first rather than reading the
list with one kind of release in mind:

```bash
CLI_CHANNEL="$(node -e 'const {resolveCliRelease}=await import("./apps/cli/scripts/cli-release-contract.mjs");process.stdout.write(resolveCliRelease(process.argv[1]).distTag)' --input-type=module "$CLI_TAG")"
printf 'this release moves %s\n' "$CLI_CHANNEL"
```

Every release:

- [ ] bootstrap package exists on npm
- [ ] `bootstrap` dist-tag names `0.0.0-bootstrap.0` — required, and re-checked by the
      workflow before and after the publish; it is never retired by a later release
- [ ] Trusted Publisher record saved and read back
- [ ] GitHub `publish` environment confirmed
- [ ] `main` CI green on the exact release commit
- [ ] release commit approved by the owner

A **prerelease** (`$CLI_CHANNEL` is `next`):

- [ ] `next` is absent, names an older prerelease, or already names the version being released
- [ ] `latest` is absent, names `0.0.0-bootstrap.0`, or names an older *stable* release — this
      release does not move it

A **stable release** (`$CLI_CHANNEL` is `latest`):

- [ ] `latest` names `0.0.0-bootstrap.0` or an older stable release. This is the one release that
      moves it, and the first one moves it off the placeholder
- [ ] `next` is left alone entirely — a stable release does not retract the prerelease channel, and
      the workflow moves no tag it did not publish to
- [ ] `@fairux/sdk` at the same version is **already published**, if this release is part of a
      paired one. The SDK is released first: a CLI on `latest` beside an SDK still on a placeholder
      would tell a consumer to install a library that resolves to a name reservation

### What had to land before the first release, and did

These were checkboxes here until the first beta shipped, and then they were checkboxes that could
never be unticked — the shape the release criteria call a permanently open row, and the shape a
reader learns to skip past. They are a record now, not a gate.

| | Landed as |
| --- | --- |
| M1-R2 | this release contract: `apps/cli/scripts/cli-release-contract.mjs` and `publish-cli.yml`, with `release-paths.yml` running its checks on every pull request that touches them |
| M1-R3 | the Windows packed-CLI matrix in `release-paths.yml` and `release-contract.yml` |
| M1-R4 | `registry-cli-smoke.yml`, which now observes `next` and `latest` as separate facts. Its `latest` cells report the placeholder until the first stable release moves it |
| M1-R5 | the SARIF upload canary, **run** rather than merely present — the observation is what closed it, and the record is in [the SARIF canary](sarif-canary.md) |

## Releasing

```bash
git switch main
git pull --ff-only origin main
git tag -a "$CLI_TAG" -m "$CLI_TAG"
git push origin "refs/tags/$CLI_TAG"
```

Re-derive `$CLI_VERSION` and `$CLI_TAG` on `main` immediately before this, and read them back — the
tag push is the one command here that cannot be undone by rerunning anything.

The tag is what triggers `publish-cli.yml`. The `publish` job waits on the environment's required
reviewer before it can mint an OIDC token.

## What the workflow refuses

Three checks run before `npm publish`, and each of them can still stop the release without
consuming the version. npm never lets a name/version pair be reused, so a check that ran only
afterwards would be reporting on something already spent.

| Checked before the publish | Refused when |
| --- | --- |
| Channel state | `bootstrap` is missing or is not exactly `0.0.0-bootstrap.0`; the channel being published to names this version, a newer one, or a version of the wrong kind; `latest` is not the bootstrap placeholder, absent, or an older stable release; on a rerun, the channel does not already name this version; any unrecognised dist-tag |
| Release tag | the tag is gone from `origin`, or no longer resolves to the commit the run was triggered by |
| Registry state | the version is already published with a different digest |

After the publish, the same channel audit runs again — the first asks whether this run may write,
the second whether the write landed where it was aimed — then the registry's provenance attestation
metadata is read back, and finally the tag is re-read immediately before the GitHub Release is
created.

The provenance read-back checks that npm *reports* attestation metadata for the exact published
version. It does not fetch the bundle or verify a signature: that is `npm audit signatures` against
a clean registry install, which belongs to the registry-installed smoke in M1-R4. The release notes
say only what was checked.

The workflow does not repair any of this. It creates, moves, and removes no dist-tag, and
`gh release create` and `gh release edit` both pass `--verify-tag`, so a Release is only ever
attached to a tag that already exists on the remote. A `latest` that appeared, a `bootstrap` that
moved, or a tag that was force-pushed is an owner decision, and this document is where the owner
finds what to check.

## What a rerun does

Rerunning repairs a release that published and then failed before its Release was created. It is
not a general repair mechanism: it works while `next` still names the target version and the
registry digest still matches. Outside that, the run stops and asks.

Repair of an existing GitHub Release is narrower still. A rerun updates the notes, title, and
assets of a Release whose tag, draft state, and prerelease classification already match this
release. It does **not** reclassify one: `gh release edit` cannot clear a prerelease flag, that
flag decides whether GitHub presents a Release as the current one, and deleting and recreating
would discard download counts and reactions on something already public. A draft, a Release on
another tag, or one classified the other way stops the run — change it on GitHub and re-run.

Each state has one answer:

| Registry state | What happens |
| --- | --- |
| the version absent | publishes |
| present, same digest | skips the publish, still verifies and repairs the Release |
| present, different digest | fails, naming the digest mismatch |
| present but not yet visible | retried, absence only, inside a 120-second deadline |
| Release already exists, correctly classified | title, notes, and assets are updated in place |
| Release already exists, draft or misclassified | fails; the workflow does not reclassify or delete a Release |
| `next` moved off the target version | fails; the workflow does not move a dist-tag |
| a channel names the target or something newer | fails before the publish |
| release tag deleted or force-moved | fails before the publish, and again before the Release |

The release notes take no clock, so regenerating them for an existing Release produces the body that
Release already has. A run that published successfully and then failed before creating the Release
is repaired by re-running it.

## After the release

### What the stable release recorded

`fairux@0.1.0` — the first **stable** CLI release — was published on 2026-08-07 from tag `v0.1.0`
(annotated, `3d3cf41e6970987531331f59f7420c057e18bbac` → `0aea85718ed6ab7e96049dc226c4aaaa78a49366`),
by run [31145894724](https://github.com/toshtag/fairux-linter/actions/runs/31145894724) — `validate`,
`prepare`, and `publish` all green on the first attempt, `publish` as job
[92765245745](https://github.com/toshtag/fairux-linter/actions/runs/31145894724/job/92765245745).

**It followed `@fairux/sdk@0.1.0`, whose registry read-back completed first.** That order is a
checklist item rather than a habit: a CLI on `latest` beside an SDK still on a placeholder would
tell a consumer to install a library that resolves to a name reservation.

Read back afterwards, from the public registry rather than from the run's own log:

```text
before                         after
bootstrap: 0.0.0-bootstrap.0   bootstrap: 0.0.0-bootstrap.0
latest:    0.0.0-bootstrap.0   latest:    0.1.0
next:      0.1.0-beta.2        next:      0.1.0-beta.2
```

`latest` moved, and this is the one release that may move it. `next` and `bootstrap` did not, and
that was checked against a reading taken before the publish rather than inferred from the current
values.

What `latest` leaving the placeholder changes for a reader: `npx fairux` and
`npm install --global fairux` resolved `0.0.0-bootstrap.0` until this release — a deprecated name
reservation with no CLI in it. The published README's own quick start was one of those commands.

| | |
| --- | --- |
| `dist.shasum` | `17623e0e0b233f87aa2c93b78dce9c1ed5dde956` |
| `dist.integrity` | `sha512-kWJQ5RP2XKaf9hlgi5sWF8HSW+TwdjyFpqiqF4w7/mI3wUsBsZk+5/oolKxqzxbHaBz4Afdgl2EmcBM7Lu0Vqg==` |
| `dist.unpackedSize` | 696911 |
| `dist.attestations` | `https://registry.npmjs.org/-/npm/v1/attestations/fairux@0.1.0`, predicates `https://github.com/npm/attestation/tree/main/specs/publish/v0.1` and `https://slsa.dev/provenance/v1` |
| GitHub Release | [`v0.1.0`](https://github.com/toshtag/fairux-linter/releases/tag/v0.1.0), **not a prerelease**, not a draft, published 2026-08-07T04:01:13Z |
| Release assets | `fairux-0.1.0.tgz` (181934 bytes), `release-sha256.txt` (83 bytes) |
| Deprecated | no |

**Two tarballs whose bytes were hashed, and one value read out of a file.**

```text
SHA-256(Release asset)
= SHA-256(registry tarball)
= digest recorded in release-sha256.txt
= ef9d4d9b457aa58a18b01535913bf88b284fbd10a22bb8a5b2423a9ef55b5f2c
```

`release-sha256.txt` is an 83-byte `<sha256>  <filename>` line. **Its own digest was not measured** —
it records the tarball's digest and is not a third copy of the tarball. The registry's `dist.shasum`
(SHA-1) recomputed from the fetched tarball matches — `17623e0e0b233f87aa2c93b78dce9c1ed5dde956` —
which is a second, independent path to the same archive.

`npm audit signatures --include-attestations`, in an empty project against a registry install,
verified the registry signature and the provenance attestation.

**One dispatch, eight green cells.**
[31146168212](https://github.com/toshtag/fairux-linter/actions/runs/31146168212) — `ubuntu-latest`
and `windows-latest`, Node 22.18.0 and 24.11.0, on **both** `next` and `latest`. The canary gained
the channel dimension before this release, and its four `latest` cells had been red since: they
refuse the placeholder rather than installing it, which is what makes this the first run in which
that channel had a release to observe.

### What the second one recorded

`fairux@0.1.0-beta.2` was published on 2026-08-06 from tag `v0.1.0-beta.2`
(annotated, `4c526badea1602a86f5a77d0a445bca73fab5062` → `e28c6a034dffb49e04cc353c96698a4b05d7c8e1`),
by run [31114252991](https://github.com/toshtag/fairux-linter/actions/runs/31114252991) — `validate`,
`prepare`, and `publish` all green on the first attempt, `publish` as job
[92660016840](https://github.com/toshtag/fairux-linter/actions/runs/31114252991/job/92660016840).
It followed `@fairux/sdk@0.1.0-beta.4`, whose registry read-back completed first.

Read back afterwards, from the public registry rather than from the run's own log:

```text
bootstrap: 0.0.0-bootstrap.0
latest:    0.0.0-bootstrap.0
next:      0.1.0-beta.2
```

`latest` did not move.

| | |
| --- | --- |
| `dist.shasum` | `d433a5db6fd6575d5ae7abace6817cced8dd5cb5` |
| `dist.integrity` | `sha512-Bx8WHWO/zNDJPKEQjQxMIXKtcOY1xCC8J9QlyK/RV5nyU/ue8I2rOaBbqPQy4psVDjX55XFDsXgBE2lNHciiEA==` |
| `dist.unpackedSize` | 696590 |
| `dist.attestations` | predicates `https://github.com/npm/attestation/tree/main/specs/publish/v0.1` and `https://slsa.dev/provenance/v1` |
| GitHub Release | [`v0.1.0-beta.2`](https://github.com/toshtag/fairux-linter/releases/tag/v0.1.0-beta.2), prerelease, not a draft, published 2026-08-06T15:11:41Z |
| Release assets | `fairux-0.1.0-beta.2.tgz` (181818 bytes), `release-sha256.txt` (90 bytes) |

**Two tarballs whose bytes were hashed, and one value read out of a file.** Written as the equation
it is: the looser phrasing this replaced put a 181818-byte archive and a 90-byte text file in one
list and called all of them 32 bytes.

```text
SHA-256(Release asset)
= SHA-256(registry tarball)
= digest recorded in release-sha256.txt
= 5cac0e6f536d189766105fe46d8aec83c62f587bb3e1d35cda0a76e498ebbe90
```

`release-sha256.txt` is a 90-byte `<sha256>  <filename>` line. **Its own digest was not measured** —
it records the tarball's digest and is not a third copy of the tarball.

`npm audit signatures --include-attestations`, in an empty project against a registry install,
verified the registry signature and the provenance attestation.

**One dispatch, four green cells**, once GitHub's Actions incident was mitigated:
[31134762665](https://github.com/toshtag/fairux-linter/actions/runs/31134762665) — `ubuntu-latest`
and `windows-latest`, on Node 22.18.0 and 24.11.0. Each cell resolved `fairux@next`, logged
`registry serves fairux@0.1.0-beta.2`, installed it into a clean project from
`https://registry.npmjs.org/`, and ran the installed-CLI contract. That is the run to read.

The three below are kept because they are evidence of something else — what a GitHub Actions
incident looks like from inside a release — and deleting them would remove the reason this section
explains itself at such length.

**During the incident, no single dispatch came back with four green cells, and not because of the
package.** GitHub's action-download service was returning `Service Unavailable`, `Internal Server
Error`, and `Bad Gateway` that afternoon. Three dispatches each lost a cell or two in `Set up job` —
before any step of this repository ran, before npm was contacted, and in a different cell each time.
A fourth dispatch was not made: the incident was ongoing, and re-dispatching until the weather
changes is not evidence.

What was measured during the incident is per cell, and every cell was observed green against
`fairux@0.1.0-beta.2` even then:

| Cell | [31114835862](https://github.com/toshtag/fairux-linter/actions/runs/31114835862) | [31115332003](https://github.com/toshtag/fairux-linter/actions/runs/31115332003) | [31115928354](https://github.com/toshtag/fairux-linter/actions/runs/31115928354) |
| --- | --- | --- | --- |
| ubuntu-latest, Node 22.18.0 | green | `Set up job` | green |
| ubuntu-latest, Node 24.11.0 | green | green | `Set up job` |
| windows-latest, Node 22.18.0 | green | green | green |
| windows-latest, Node 24.11.0 | `Set up job` | green | `Set up job` |

Each green cell resolved `next`, fetched `fairux@0.1.0-beta.2` from `https://registry.npmjs.org/`
with the published integrity, installed it into a clean project, and ran the installed-CLI contract.
Each red one failed at `Failed to resolve action download info` with no repository step attempted.

The failed runs are kept. A release record that deletes its own red runs is not a record — and the
distinction that matters here is the one the first release had to learn the hard way: a Windows cell
reporting `status: unavailable` was a real defect in this repository's subprocess runner, and looked
exactly like an absent package. These do not look like that. They name GitHub's own service and stop
before the job begins.

**Behaviour smoke against the published package**, in an empty project with `npm install fairux@next`:
the safe remediation removed `checked` from a pre-checked consent box with `--fix-write`;
`--suppress` produced an `externalFilters` record carrying a relative path and a `sha256:` digest;
and `--stdin-filename Page.tsx` selected the `ast` runtime for a piped document. All three are
`0.1.0-beta.2` additions, exercised through the binary a user installs.

### What the first one recorded

`fairux@0.1.0-beta.1` was published on 2026-08-06 from tag `v0.1.0-beta.1`, by run
[31079370990](https://github.com/toshtag/fairux-linter/actions/runs/31079370990) — `validate`,
`prepare`, and `publish` all green. Read back afterwards:

```text
bootstrap: 0.0.0-bootstrap.0
latest:    0.0.0-bootstrap.0
next:      0.1.0-beta.1
```

`latest` did not move, which is the contract working rather than something to correct. The registry
tarball is byte-identical to the Release asset, and its SHA-256 equals the digest recorded **in**
`release-sha256.txt` — a `<sha256>  <filename>` line, not a third copy of the tarball, which this
sentence used to claim it was. `npm audit signatures` reports SLSA provenance, and
`registry-cli-smoke.yml` is green on all four cells.

The canary's Windows cells were red on the first dispatch, and not because of the package: the
release scripts' subprocess runner could not start `npm.cmd`, so both cells reported
`status: unavailable` — the same word an absent package produces, which is why nothing had noticed
while the package really was absent. Fixed in `scripts/release-subprocess.mjs` and re-dispatched
green. Read all four cells; two of them are a platform the rest of this runbook cannot exercise.

### For the next one

`docs/roadmap.md` describes what is published, and the workflow does not change it: a release path
that commits to the repository would be writing the claim it is supposed to be evidence for.

Update it in a separate pull request, after reading the registry:

```bash
npm view "$CLI_SPEC" version dist.integrity dist.shasum --json \
  --registry=https://registry.npmjs.org/
npm view fairux dist-tags --json --registry=https://registry.npmjs.org/
gh release view "$CLI_TAG"
```

Record what those commands returned, not what the release was supposed to do. The SDK's closeout
did the same, and the difference mattered: its first attempt was recorded as a failure while the
package existed on npm.

Then dispatch the registry-installed smoke and read all four cells:

```bash
gh workflow run registry-cli-smoke.yml --ref main
```

This is the first run of that workflow that can mean anything, and it is what turns "published"
into "published and verified as installed from the registry". Until it is green on `main`, the
status document says the CLI is published and *not* registry-verified — those are different claims,
and only one of them has evidence.
