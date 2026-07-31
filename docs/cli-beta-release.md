# FairUX CLI beta release runbook

How `fairux@0.1.0-beta.1` gets to npm, and what has to be true first.

The repository-side release contract is implemented. The external prerequisites are not, and no
amount of repository work can satisfy them: they are owner actions on npmjs.com. This document is
where they are written down, so that the first tag push is not the place they are discovered.

Nothing here has been executed. `fairux` is not on npm, no `v*` tag exists, and no GitHub Release
for the CLI exists.

## Publication contract

| Property | Value |
| --- | --- |
| Package | `fairux` (unscoped, public) |
| First real release | `0.1.0-beta.1` |
| Git tag | `v0.1.0-beta.1` |
| npm dist-tag | `next` |
| Bootstrap placeholder | `0.0.0-bootstrap.0` on the `bootstrap` dist-tag |
| `latest` | **absent** until the first stable release |
| Workflow | `.github/workflows/publish-cli.yml` |
| GitHub environment | `publish` |

Dist-tag rules, enforced by `apps/cli/scripts/cli-dist-tag-contract.mjs`:

- A prerelease never goes to `latest`.
- The bootstrap placeholder never goes to `latest`, and is never published by the workflow.
- `latest` may be absent; a plain `npm install --global fairux` resolving nothing is the intended
  state until there is a stable release to resolve.
- If `latest` **exists** when a prerelease is published, the run fails and asks the owner. The
  workflow does not create, move, or remove a dist-tag — `npm publish --tag next` does not set
  `latest`, so a `latest` that exists is a fact nobody in this repository produced deliberately, and
  deleting registry state to make a check pass is not a fix.
- `next` must name exactly the version the run published, read back after the publish.

Why `latest` is left absent rather than parked on the placeholder, which is what `@fairux/sdk`
does: both stop `npm install` from resolving a beta, and absent does not additionally advertise a
version nobody should install.

## External Configuration Checklist

Repository owners must complete these before pushing `v0.1.0-beta.1`:

- npm account ownership of the unscoped name `fairux`;
- the bootstrap publish below, which creates the package;
- npm Trusted Publisher configured for `fairux`, with the exact field values below;
- npm package access is public;
- GitHub `publish` environment exists, with its protection rules and reviewer intentional;
- release approver has reviewed the exact commit on `main`;
- `0.1.0-beta.1` is not already present on npm.

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
latest:    absent
next:      absent
```

If `latest` appeared anyway, that is the one case where the owner removes a dist-tag by hand, after
confirming why it is there:

```bash
npm dist-tag rm fairux latest
```

Then mark the placeholder so nobody installs it in passing:

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
[the SDK runbook](sdk-beta-release.md) for what is and is not established about the connection.

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

npmjs.com → `fairux` → Settings → Trusted Publisher shows the same values, and is the way to change
them. npm does not validate the record on save, so re-open the page afterwards and read the stored
values rather than trusting that the save succeeded.

## Rehearsing the release

Everything except the registry runs locally and in pull-request CI:

```bash
pnpm release:check:cli -- --tag v0.1.0-beta.1
pnpm release:dry-run:cli -- --tag v0.1.0-beta.1
```

The dry run packs once, smokes the exact tarball, audits those bytes against the release contract,
renders the release notes through the same invocation the workflow uses, and runs
`npm publish --dry-run`. `cli-release-preflight` runs it on every pull request on Node.js 22.18.0
and 24.11.0.

It reads no registry. `fairux` is absent from npm, so every read of it is an `E404`; that is the
correct external state, not something to assert around. The publication plan's own logic is covered
by `tests/unit/cli-registry-plan.test.ts` with injected readers.

## Pre-release checklist

Before the tag is pushed:

- [ ] bootstrap package exists on npm
- [ ] `bootstrap` dist-tag names `0.0.0-bootstrap.0` — required, and re-checked by the
      workflow before and after the publish; it is never retired by a later release
- [ ] `latest` is absent
- [ ] `next` is absent, or already names the version being released
- [ ] Trusted Publisher record saved and read back
- [ ] GitHub `publish` environment confirmed
- [ ] M1-R2 merged (this release contract)
- [ ] M1-R3 merged (Windows packed CLI matrix)
- [ ] M1-R4 merged (registry-installed CLI smoke)
- [ ] M1-R5 merged (SARIF upload canary)
- [ ] `main` CI green on the exact release commit
- [ ] release commit approved by the owner

## Releasing

```bash
git switch main
git pull --ff-only origin main
git tag v0.1.0-beta.1
git push origin v0.1.0-beta.1
```

The tag is what triggers `publish-cli.yml`. The `publish` job waits on the environment's required
reviewer before it can mint an OIDC token.

## What the workflow refuses

Three checks run before `npm publish`, and each of them can still stop the release without
consuming the version. npm never lets a name/version pair be reused, so a check that ran only
afterwards would be reporting on something already spent.

| Checked before the publish | Refused when |
| --- | --- |
| Channel state | `latest` exists; `bootstrap` is missing or is not exactly `0.0.0-bootstrap.0`; `next` already exists on a first publish, or does not name this version on a rerun; any unrecognised dist-tag |
| Release tag | the tag is gone from `origin`, or no longer resolves to the commit the run was triggered by |
| Registry state | the version is already published with a different digest |

After the publish, the same channel audit runs again — the first asks whether this run may write,
the second whether the write landed where it was aimed — followed by a second read of the tag
immediately before the GitHub Release is created.

The workflow does not repair any of this. It creates, moves, and removes no dist-tag, and
`gh release create` and `gh release edit` both pass `--verify-tag`, so a Release is only ever
attached to a tag that already exists on the remote. A `latest` that appeared, a `bootstrap` that
moved, or a tag that was force-pushed is an owner decision, and this document is where the owner
finds what to check.

## What a rerun does

Rerunning repairs a release that published and then failed before its Release was created. It is
not a general repair mechanism: it works while `next` still names the target version and the
registry digest still matches. Outside that, the run stops and asks.

Each state has one answer:

| Registry state | What happens |
| --- | --- |
| `0.1.0-beta.1` absent | publishes |
| present, same digest | skips the publish, still verifies and repairs the Release |
| present, different digest | fails, naming the digest mismatch |
| present but not yet visible | retried, absence only, inside a 120-second deadline |
| Release already exists | title, notes, and assets are updated in place |
| `next` moved off the target version | fails; the workflow does not move a dist-tag |
| release tag deleted or force-moved | fails before the publish, and again before the Release |

The release notes take no clock, so regenerating them for an existing Release produces the body that
Release already has. A run that published successfully and then failed before creating the Release
is repaired by re-running it.

## After the release

`docs/status.md` and `docs/roadmap.md` describe `fairux` as unpublished, and the workflow does not
change them: a release path that commits to the repository would be writing the claim it is
supposed to be evidence for.

Update them in a separate pull request, after reading the registry:

```bash
npm view fairux@0.1.0-beta.1 version dist.integrity dist.shasum --json \
  --registry=https://registry.npmjs.org/
npm view fairux dist-tags --json --registry=https://registry.npmjs.org/
gh release view v0.1.0-beta.1
```

Record what those commands returned, not what the release was supposed to do. The SDK's closeout
did the same, and the difference mattered: its first attempt was recorded as a failure while the
package existed on npm.
