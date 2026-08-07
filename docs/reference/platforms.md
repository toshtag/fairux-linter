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

Two floors rather than a range: they are the exact versions the release lane installs, so
"supported" means "observed working" rather than "expected to work". Anything above 24.11.0 is
likely fine and is not tested, which is a different claim and worth keeping different.

One version in between **is** tested. Pull-request CI installs an exact version chosen for runner
efficiency — the one the GitHub image already carries, so no job spends five seconds downloading
Node before it can start. `.github/workflows/ci.yml` is the source of truth for which version that
is, and it is not restated here: it tracks whatever the runner image ships, so a page that named it
would need editing when GitHub moves the image, for a fact no consumer of this project depends on.

What is a contract, and is checked by `tests/unit/workflows/node-contract.test.ts`: it is an exact
version, and it is inside `engines`. A floating `22` would be faster to write and is refused for the
same reason a `@v7` action tag is — what a name points at can change without this repository
changing.

"The whole suite" is `release-contract.yml`'s `suite-on-both-floors` job, once per floor, after the
merge. Pull-request CI runs the same suite sharded on that in-between version, for speed — the row
above does not rest on those adding up, and does not rest on the version they run on.

That row was wrong until it was checked. The suite had never run on 24.11.0: every job carrying the
floor matrix packed a tarball or rehearsed a release, and the one that ran the tests was pinned to
22.18.0. The contract test below this page's name now reads the workflows for a job that runs the
suite whole and resolves the Node version through its matrix, so the sentence and the thing it
describes fail together.

## Operating systems

| OS | What runs on it |
| --- | --- |
| Linux x64 (`ubuntu-latest`) | Everything, after the merge: the whole suite on both Node floors, both pack smokes, both release preflights, the packed-artifact and bundle-handoff contracts, build idempotency, registry routing |
| Linux arm64 (`ubuntu-24.04-arm`) | Everything a pull request is checked by: build, build-output contract, lint, typecheck, runtime safety, the generated-artifact checks, and the whole suite, sharded |
| Windows (`windows-latest`) | The packed CLI's behaviour contract, config discovery, and the registry CLI canary |

arm64 is here because GitHub gives public repositories those runners at no cost and they are faster
at this work — the whole suite is 25s on arm64 against 28–33s on x64, on the same four cores. It is
not a claim about consumers; nothing published here contains native code, and the only architecture-
specific binaries in reach are the toolchain's. x64 did not lose a check when the pull-request lane
moved: it kept every one of them, an hour later, on `main`.

Windows is tested because it broke: `fairux scan "inputs\*.html"` matched nothing, since neither
`cmd.exe` nor PowerShell expands globs and a backslash in a pattern is an escape character. The
installed-CLI contract now runs the native and portable glob forms on Windows and requires them to
name the same files.

macOS is not in CI. It is a Unix host running the same Node build as Linux, and nothing in this
repository is platform-specific beyond the path handling Windows already exercises.

## How a file gets written

Every flag that writes does it one of two ways.

`--write-baseline` and `--risk-index` create files this tool owns. Those are written to a temporary
file in the same directory and renamed into place, so an interrupted write cannot leave a truncated
file where a valid one was. A path you named as an output is replaced, as with any other tool.

`--fix-write` rewrites a file you are editing, and opens that file rather than replacing it. The
inode does not change, so nothing attached to it does either: the mode, the owner, ACLs, extended
attributes, the symlink pointing at it, the other hard links, and — on Windows — the security
descriptor. This is how `prettier --write` and `eslint --fix` write, and it is available on every
supported platform.

The file is opened first and its checksum verified through that same open file, so the bytes that
are checked and the bytes that are replaced are the same file — an editor saving atomically between
a read and an open would otherwise have its new file truncated on the strength of the old one.

The trade is that the risky window is inside the file rather than beside it. A write that fails
partway leaves the file short, so the original bytes are held and written back; if that restore also
fails, the run says so in as many words.

What is *not* guaranteed: several files are not a transaction — a refusal partway leaves some
written and some not, and the run says which. Nothing here survives a power loss; no formatter's
in-place write does.

A change the checksum or the path-identity check observes is refused, never merged. Those checks run
immediately before the write and again after it, which is as close as a lock-free write gets: FairUX
holds no cross-process lock and does not claim to exclude every concurrent write.
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

## Extension hosts

Two surfaces ship as extensions, and what each is *tested on* is not the same as what each *runs on*.

| Surface | Unit tests | Real host |
| --- | --- | --- |
| VS Code extension | vitest, against `src/diagnostics.ts` and `src/settings.ts`, neither of which imports `vscode` | `vscode-host-smoke.yml` — a downloaded VS Code, on Linux x64 under `xvfb`, weekly and on every `main` push that touches it |
| Chrome extension | vitest under `happy-dom`, with a hand-written `chrome.*` stub | `chrome-host-smoke.yml` — Playwright's bundled Chromium on Linux x64, weekly and on every `main` push that touches it |

Neither smoke is on the pull-request lane, and both run on x64 rather than the free arm64 runners the
PR lane uses: an Electron application and a full Chromium build both need desktop libraries and
architecture-specific builds that the arm64 images do not carry.

The VS Code smoke is what `src/extension.ts` never had. That file imports `vscode`, so no unit test
can import it at all, and its wiring was previously checked by reading it: whether `activate()` runs,
whether `onDidChangeConfiguration` fires for `fairux.*`, whether a diagnostic's range covers what the
finding is about. Those are observations now. Run it with:

```bash
pnpm smoke:vscode
```

It is not part of `pnpm verify:full`, which is offline and fast; this downloads a VS Code build and
starts a desktop application.

The Chrome smoke is what the `chrome.*` stub never could be. Run it with:

```bash
pnpm smoke:chrome
```

It loads the built extension into **Playwright's bundled Chromium** — not Google Chrome, which
removed `--load-extension` in 151 — puts a normal HTTP page in the active tab, and opens the real
action popup through CDP `Extensions.triggerAction`. What ends up highlighted has to be the element
inside the **open shadow root**, resolved by the content script one root at a time. Neither the
extension nor its `web_accessible_resources` changes for it.

**It drives the popup with the keyboard**, which is what the finding row was rebuilt from a `<li>`
into a real `<button>` to support. Tab from the popup body reaches Scan; Enter activates it; Tab
reaches the finding; Shift+Tab goes back and Tab returns, so the order is an order rather than one
lucky `tabindex`; Space activates the finding. Two keys on purpose — a button fires its click on
Enter's keydown and on Space's keyup, and using one key for both controls would leave the other
untested. Each focused element is recorded with whether the engine calls it keyboard focus *and*
whether a ring is actually painted, since `:focus-visible` keeps matching under `outline: none`.

A pointer activation runs afterwards as a second observation, never as a substitute: a green
keyboard run says nothing about hit areas, and a green pointer run says nothing about focus order or
activation semantics.

Two things it will not do, for the same reason. It does not navigate a tab to `popup.html`: the
popup would then be the active tab, `chrome.scripting.executeScript` would target the extension's own
document, and the shadow-root path would never run. And it does not fall back to the headless shell,
which ships without the extensions subsystem — `channel: "chromium"` is the option whose removal
turns the whole smoke into a test of nothing, and removing it is one of the mutations that has to
fail.

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

What they last measured is not recorded here. A page describing supported platforms would have to be
edited after every release to keep such a note true, and it was: this paragraph named two beta
versions and the channel they sat on long after both had moved. The runs and their results are in
[the release criteria](../maintainers/release-criteria.md) and the two runbooks, where a release
already updates them.
