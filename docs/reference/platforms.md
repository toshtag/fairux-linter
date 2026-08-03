# Supported platforms

What FairUX is tested on, and what "supported" means for each.

> Every number here is asserted against the repository by
> `tests/unit/supported-platforms-contract.test.ts`. A floor documented but untested, or tested but
> undocumented, fails that test — which is the failure this page exists to prevent, because it is the
> one nobody notices until a consumer's install breaks.

## Node.js

**`^22.18.0 || >=24.11.0`**, declared in `engines` on every published package and tested on both
floors in CI.

| Version | What runs on it |
| --- | --- |
| 22.18.0 | The whole suite, the packed CLI on Linux and Windows, both registry canaries |
| 24.11.0 | The same |

Two floors rather than a range: they are the exact versions CI installs, so "supported" means
"observed working" rather than "expected to work". Anything between them or above 24.11.0 is likely
fine and is not tested, which is a different claim and worth keeping different.

"The whole suite" is `release-contract.yml`'s `suite-on-both-floors` job, once per floor, after the
merge. Pull-request CI runs the same suite in four shards on 22.18.0, for speed — the row above does
not rest on those adding up.

That row was wrong until it was checked. The suite had never run on 24.11.0: every job carrying the
floor matrix packed a tarball or rehearsed a release, and the one that ran the tests was pinned to
22.18.0. The contract test below this page's name now reads the workflows for a job that runs the
suite whole and resolves the Node version through its matrix, so the sentence and the thing it
describes fail together.

## Operating systems

| OS | What runs on it |
| --- | --- |
| Linux (`ubuntu-latest`) | Everything |
| Windows (`windows-latest`) | The packed CLI's behaviour contract, config discovery, and the registry CLI canary |

Windows is tested because it broke: `fairux scan "inputs\*.html"` matched nothing, since neither
`cmd.exe` nor PowerShell expands globs and a backslash in a pattern is an escape character. The
installed-CLI contract now runs the native and portable glob forms on Windows and requires them to
name the same files.

macOS is not in CI. It is a Unix host running the same Node build as Linux, and nothing in this
repository is platform-specific beyond the path handling Windows already exercises.
"not tested" is the accurate word for it, and it is the word this page uses.

## Browsers

`@fairux/core`, `@fairux/rules`, `@fairux/dom`, and `@fairux/report` are browser-safe: no Node
built-ins, enforced by `scripts/check-runtime-safety.mjs` and by each package's TypeScript
configuration.

The SDK's browser bundle is built and executed against a DOM in the pack smoke, with two size
ceilings — one on what esbuild emits, one on what a consumer actually serves after minification.

No specific browser version is claimed. The code targets the ES features TypeScript emits for the
configured target and uses no browser API beyond `getComputedStyle`, `getBoundingClientRect`, and
constraint validation, each behind an opt-in.

## What is not supported

- **Deno and Bun.** They may work; nothing here runs on them.
- **Node 20 and below.** Below the `engines` floor, and the CI actions themselves run on Node 24
  runtimes.
- **A browser without the DOM APIs the visual and form capabilities need.** Those are opt-in, and a
  scan without them reports the capabilities as unavailable rather than failing.

## Registry canaries

Two scheduled workflows install from the public registry and run the same contracts a release does:

| Workflow | What it proves | Schedule |
| --- | --- | --- |
| `registry-consumer-smoke.yml` | A clean `@fairux/sdk` install from npm still composes an external pack | Weekly, Monday 05:23 UTC |
| `registry-cli-smoke.yml` | The published CLI installs and runs its behaviour contract | Weekly, plus dispatch |

Both are read-only, both run on both Node floors, and neither is a required check — a canary that
blocked merges would be a test of npm's availability. The CLI one currently fails by design, and
accurately: `fairux` does not exist on the registry yet.
