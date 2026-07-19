# SDK beta release runbook

This runbook tracks the `@fairux/sdk@0.1.0-beta.1` release path. It does not authorize a publish by
itself.

## Release Automation

The SDK release is separate from the CLI release:

- CLI workflow: `.github/workflows/publish-cli.yml`, triggered by `v*` tags, version source
  `apps/cli/package.json`.
- SDK workflow: `.github/workflows/publish-sdk.yml`, triggered by `sdk-v*` tags, version source
  `packages/sdk/package.json`.

The first SDK beta tag is:

```text
sdk-v0.1.0-beta.1
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
pnpm typecheck
pnpm test
pnpm check:runtime-safety
pnpm pack:smoke
pnpm pack:smoke:sdk
pnpm release:check:sdk -- --tag sdk-v0.1.0-beta.1
pnpm release:dry-run:sdk -- --tag sdk-v0.1.0-beta.1
pnpm test:rule-pack-author-example
pnpm exec code-pact validate --json
pnpm exec code-pact plan lint --json
```

`pnpm pack:smoke:sdk` also accepts an exact tarball contract used by the workflow:

```bash
TARBALL=/path/to/fairux-sdk-0.1.0-beta.1.tgz \
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
git tag sdk-v0.1.0-beta.1
git push origin sdk-v0.1.0-beta.1
npm publish
```

The PR may prepare automation and dry-run checks only. Public publication, GitHub Release creation,
and registry-installed smoke tests happen after approval and tag push.

## Post-Publish Verification

After the workflow publishes, verify from the npm registry, not from a local tarball:

```bash
mkdir /tmp/fairux-sdk-registry-smoke
cd /tmp/fairux-sdk-registry-smoke
npm init -y
npm install @fairux/sdk@0.1.0-beta.1
npm view @fairux/sdk@0.1.0-beta.1 version
npm view @fairux/sdk dist-tags
npm view @fairux/sdk@0.1.0-beta.1 dist.integrity
npm view @fairux/sdk@0.1.0-beta.1 dist.attestations
```

Then run the same root, HTML, DOM/browser bundle, custom RulePack, and TypeScript consumer checks
against the registry-installed package.

The reusable command is:

```bash
SDK_SPEC=@fairux/sdk@0.1.0-beta.1 \
EXPECTED_VERSION=0.1.0-beta.1 \
pnpm registry:smoke:sdk
```

P20 is not done until registry install, provenance or attestation, GitHub Release, and
post-publish smoke evidence are recorded.

## Source Maps

The SDK beta tarball does not publish source maps. Release audit fails if `dist/*.map` files appear
in the tarball, and the source-map audit rejects embedded `sourcesContent`, absolute build-host
paths, repository paths, `packages/*/src`, `workspace:`, and `file://` sources.
