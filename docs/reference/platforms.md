# Supported platforms

What FairUX is tested on, and what "supported" means for each.

> Every version here is checked against the workflows by
> `tests/unit/supported-platforms-contract.test.ts`: a floor documented but untested, or tested but
> undocumented, fails.

## Node.js

**`^22.18.0 || >=24.11.0`**, declared in `engines` on every published package and tested on both
floors in CI.

| Version | What runs on it |
| --- | --- |
| 22.18.0 | The whole suite, the packed CLI on Linux and Windows, both registry canaries |
| 24.11.0 | The same |

Two floors rather than a range: they are the exact versions the release lane installs, so
"supported" means "observed working" rather than "expected to work". Anything above 24.11.0 is
likely fine and is not tested, which is a different claim and worth keeping different.

One version between the floors is also exercised, by pull-request CI. Which version is in
`.github/workflows/ci.yml`; it is always an exact version inside `engines`, never a floating major,
and `tests/unit/workflows/node-contract.test.ts` holds that.

## Operating systems

| OS | What runs on it |
| --- | --- |
| Linux x64 (`ubuntu-latest`) | Everything, after the merge: the whole suite on both Node floors, both pack smokes, both release preflights, the packed-artifact and bundle-handoff contracts, build idempotency, registry routing |
| Linux arm64 (`ubuntu-24.04-arm`) | Everything a pull request is checked by: build, build-output contract, lint, typecheck, runtime safety, the generated-artifact checks, and the whole suite, sharded |
| Windows (`windows-latest`) | The packed CLI's behaviour contract, config discovery, and the registry CLI canary |

Architecture is not a claim made to consumers: nothing published here contains native code, and the
only architecture-specific binaries in reach are the toolchain's.

Windows has its own jobs because path and glob handling differ there — neither `cmd.exe` nor
PowerShell expands globs, and a backslash in a pattern is an escape character. The installed-CLI
contract runs the native and portable glob forms there and requires them to name the same files.

There is no macOS job. It is a Unix host running the same Node build as Linux, and nothing here is
platform-specific beyond the path handling Windows already exercises — so it is untested rather than
known-good.

## Browsers

`@fairux/core`, `@fairux/rules`, `@fairux/dom`, and `@fairux/report` are browser-safe: no Node
built-ins, enforced by `scripts/check-runtime-safety.mjs` and by each package's TypeScript
configuration.

The SDK's browser bundle is built and executed against a DOM in the pack smoke, with two size
ceilings — one on what esbuild emits, one on what a consumer actually serves after minification.

No specific browser version is claimed. The code targets the ES features TypeScript emits for the
configured target and uses no browser API beyond `getComputedStyle`, `getBoundingClientRect`, and
constraint validation, each behind an opt-in.

## Extension hosts

Two surfaces ship as extensions, and what each is *tested on* is not the same as what each *runs on*.

| Surface | Unit tests | Real host |
| --- | --- | --- |
| VS Code extension | vitest, against `src/diagnostics.ts` and `src/settings.ts`, neither of which imports `vscode` | `vscode-host-smoke.yml` — a downloaded VS Code, on Linux x64 under `xvfb`, weekly and on every `main` push that touches it |
| Chrome extension | vitest under `happy-dom`, with a hand-written `chrome.*` stub | `chrome-host-smoke.yml` — Playwright's bundled Chromium on Linux x64, weekly and on every `main` push that touches it |

Both run on Linux x64, weekly and on every `main` push that touches them.

Run either locally:

```bash
pnpm smoke:vscode   # downloads a VS Code build and starts a desktop application
pnpm smoke:chrome   # loads the built extension into Playwright's bundled Chromium
```

The Chrome smoke uses Playwright's bundled Chromium rather than Google Chrome, which removed
`--load-extension` in 151. It exercises the popup by keyboard as well as by pointer, and resolves a
finding inside an **open shadow root** — the case a `chrome.*` stub cannot reach. Neither the
extension nor its `web_accessible_resources` changes for it.

## What is not supported

- **Deno and Bun.** They may work; nothing here runs on them.
- **Node 20 and below.** Below the `engines` floor, and the CI actions themselves run on Node 24
  runtimes.
- **A browser without the DOM APIs the visual and form capabilities need.** Those are opt-in, and a
  scan without them reports the capabilities as unavailable rather than failing.

## Registry canaries

Two scheduled workflows install from the public registry and run the same contracts a release does:

| Workflow | What it proves | Trigger |
| --- | --- | --- |
| `registry-consumer-smoke.yml` | A clean `@fairux/sdk` install from npm still composes an external pack | Scheduled, plus dispatch |
| `registry-cli-smoke.yml` | The published CLI installs and runs its behaviour contract | Scheduled, plus dispatch |

Both are read-only, both run on both Node floors and over each channel this project publishes to,
and neither is a required check — a canary that blocked merges would be a test of npm's
availability.

Results are not recorded here. The runs and what they measured are in
[the release criteria](../maintainers/release-criteria.md) and the two release runbooks.
