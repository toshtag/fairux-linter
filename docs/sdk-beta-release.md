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
- npm Trusted Publisher configured for this repository;
- Trusted Publisher workflow filename set to `.github/workflows/publish-sdk.yml`;
- npm package access is public;
- GitHub `publish` environment exists;
- environment protection and reviewer requirements are intentional;
- release approver has reviewed the exact commit on `main`;
- package version is not already present on npm.

Do not add an npm token secret as a workaround. The intended release path is Trusted Publishing via
OIDC provenance.

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
mode, and the owner separately rechecked the Trusted Publisher fields. Removing `registry-url` is
the recovery under test; a successful `0.1.0-beta.2` publication is what will confirm it end to
end. The mechanism: `actions/setup-node`
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

`node scripts/check-trusted-publishing.mjs` now runs in both publish jobs — once before any work,
and again immediately before `npm publish`, since install and lifecycle scripts run in between and
could introduce a credential the first run could not have seen.

It checks the **local** prerequisites: npm ≥ 11.5.1, both OIDC request variables present, no
credential in the environment, and no credential key — `_auth`, `_authToken`, `username`,
`_password`, `certfile`, `keyfile` — in the project, user, or global npm config. A config it cannot
read aborts the check rather than being treated as empty. It reports without echoing any value.

Environment detection mirrors npm's own `npm_config_` key normalization, transcribed from
`@npmcli/config`: keys beginning with `//` are **not** normalized, so
`npm_config_//registry.npmjs.org/:_authToken` is a real registry credential and is refused, while
`NPM_CONFIG_REGISTRY` and `NPM_CONFIG_AUTH_TYPE` are not credentials and are not.

### Privilege boundary

The publish workflows split into `validate` → `prepare` → `publish`, and only `publish` holds
`id-token: write`.

`prepare` is where `pnpm install` and `prepack` run — that is, where dependency and package
lifecycle scripts execute. It has `contents: read`, no environment, and no OIDC token, so nothing
it runs can mint a token, publish, or write to the repository. It packs the tarball once, smokes
and audits it, and uploads a bundle: the tarball, its checksum file, release notes, and a
`release-metadata.json` naming the package, version, dist-tag, digests, tag, and commit.

`publish` installs nothing and builds nothing. It downloads the bundle, and
`scripts/verify-release-bundle.mjs` **re-derives** the SHA-1, SHA-256, and integrity from the bytes
rather than trusting the metadata, and refuses a bundle whose tag, commit, package, version, or
tarball name does not match this run and the checked-out manifest. Every script it runs uses Node
built-ins only, so no dependency tree is present while a token can be minted.

The CLI workflow has the same split. Its publish job keeps `contents: read`, because it creates no
GitHub Release.

Two things it does **not** do. It does not contact npm, so it cannot confirm that a matching
Trusted Publisher record exists — only a real publish proves that. And it does not preserve the
version number: the workflow is triggered by `push.tags`, so the tag already exists before any step
runs. What it saves is the wasted build, smoke, audit, and artifact work, and a registry attempt
that cannot succeed.

## Post-Publish Verification

After the workflow publishes, verify from the npm registry, not from a local tarball:

```bash
mkdir /tmp/fairux-sdk-registry-smoke
cd /tmp/fairux-sdk-registry-smoke
npm init -y
npm install @fairux/sdk@0.1.0-beta.2
npm view @fairux/sdk@0.1.0-beta.2 version
npm view @fairux/sdk dist-tags
npm view @fairux/sdk@0.1.0-beta.2 dist.integrity
npm view @fairux/sdk@0.1.0-beta.2 dist.attestations
```

Then run the same root, HTML, DOM/browser bundle, custom RulePack, and TypeScript consumer checks
against the registry-installed package.

The reusable command is:

```bash
SDK_SPEC=@fairux/sdk@0.1.0-beta.2 \
EXPECTED_VERSION=0.1.0-beta.2 \
pnpm registry:smoke:sdk
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
