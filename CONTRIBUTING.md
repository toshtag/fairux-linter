# Contributing to FairUX

Thanks for your interest! FairUX is a rule-based UX-risk linter. Bug reports, fixtures of
real-world dark patterns, rule ideas, and PRs are all welcome.

## Getting started

```bash
pnpm install
pnpm verify   # lint, build-backed typecheck, tests, runtime safety
```

`pnpm verify` is what to run before opening a pull request. CI runs it and a handful of
repository-wide checks on top; you do not need to run those yourself, and if one fails it says what
to do.

While you work, run the tests for what you are changing:

```bash
pnpm test                    # build, then the whole suite
pnpm exec vitest run <path>  # one file
pnpm build                   # all packages
pnpm fairux scan <path>      # the CLI against a file
```

**Run the plain script names.** Several have a `:built` sibling — `test:built`, `typecheck:built`,
and so on. The plain name builds first, so it works against a cold checkout. The sibling skips the
build and is for CI; locally it checks your last build rather than your change.

## Checks worth knowing about

Everything here runs in CI. These four are the ones whose failures are easiest to misread.

**`check:runtime-safety`** — `@fairux/core` and `@fairux/rules` must stay free of Node built-ins,
the DOM, and parser dependencies, so the same rules can run in a browser extension. Anything
platform-specific belongs in an adapter, in `@fairux/config-node`, or in an app.

**`check:build-output`** — a hand-written `.mjs` or `.d.mts` is treated as build output wherever it
sits, because those extensions are what the build emits. They belong in a `scripts/` directory or in
`tests/fixtures/`. A test helper that reads the filesystem goes in `scripts/`, not beside the test.

**`check:doc-references`** — fails when a document names a `pnpm` script or a repository path that
is not there. If a document has to mention something that no longer exists, say so in prose rather
than in the notation a reader would copy and run.

**`eval:corpus:check`** — fails when a labelled corpus page stops reporting what it is labelled
with, and names the page and the rule:

```text
corpus regressions:
  clean-informational-page-en: consent/missing-reject-option reported 1 fewer than labelled
```

That is a regression in your change. If the new behaviour is the correct one, update that page's
`expected` in `corpus/manifest.json` and say in the pull request why the old label was wrong.

## Design boundaries

Three constraints that are not obvious from the code.

1. **`@fairux/core` and `@fairux/rules` stay browser-safe.** Enforced by `check:runtime-safety` and
   by each package's `tsconfig`.

2. **Findings are risk signals, not verdicts.** No legal or accusatory language — "illegal",
   "malicious", "fraud". Prefer "may", "review recommended". Detection is deterministic; there is no
   AI in the engine.

3. **Third-party RulePacks are trusted executable code.** FairUX validates metadata and finding
   output, but it does not sandbox `evaluate()`. Pin and review external RulePack dependencies.

The JSON output (`FairUxReport`) is a **public API** — additive changes only. See
[`docs/reference/report-schema.md`](docs/reference/report-schema.md).

## Writing a rule

Aim for **few, explainable, high-precision rules** over many noisy ones. A new rule should:

- live under `packages/rules/src/<category>/`, export a `Rule`, and be registered in `registry.ts`;
- put match phrases in `dictionary.ts` (**English + Japanese**; never use the `/g` or `/y` flag);
- ship **positive, negative, and Japanese** fixtures — the negative cases (no false positive)
  matter most;
- scope itself when context-dependent (`appliesTo` page contexts, or local-container checks) to
  avoid firing on unrelated pages.

### What a rule change is responsible for

**Yours:**

- the rule, registered, with its dictionary phrases;
- positive, negative, and Japanese unit fixtures under `packages/rules/test/`;
- a `ruleVersion` bump and an updated review record when what the rule matches changes;
- not breaking an existing corpus page — `eval:corpus:check` names any that you did.

A change to what a rule detects regenerates two files, one command each:

```bash
pnpm rules:reviews:update   # rule-review-baseline.json
pnpm rules:catalog          # docs/generated/rule-catalog.{md,json}
```

Include both in the pull request. Nothing else is regenerated.

**Not yours:**

- adding corpus pages. A new rule does not need one, and a new dictionary locale does not need one;
- the corpus's composition, or its coverage of the dictionary;
- the Risk Index calibration and its collections;
- the behaviour probe set in `packages/rules/scripts/behaviour-probe.mjs`;
- the third-party fixtures under `corpus/third-party/`, including their licensing and provenance.

A corpus page is added when something is learned that a unit test cannot hold — a real false
positive, a parser and DOM adapter disagreeing, an interaction between elements. That is a
maintainer's call, and reporting the case is enough.

## Project shape

A pnpm + TypeScript monorepo:

- `packages/core` — the engine (types, `scan()`, fingerprinting). **Browser-safe.**
- `packages/rules` — the rule set + keyword dictionaries (en/ja). **Browser-safe.**
- `packages/html` · `packages/dom` · `packages/ast` · `packages/figma` — input adapters
  (HTML / live DOM / JSX-TSX / Figma JSON).
- `packages/report` — JSON / Markdown / SARIF reporters.
- `packages/config-node` — Node-only config discovery and loading. **Not browser-safe**, by design.
- `packages/sdk` — the public facade (`@fairux/sdk`).
- `apps/cli` · `apps/chrome-extension` · `apps/vscode-extension` — the surfaces.

`docs/` is organized by audience, which is the first question when adding a document:

| Directory | Who opens it |
| --- | --- |
| `docs/guides/` | somebody using FairUX in their project |
| `docs/reference/` | somebody depending on FairUX |
| `docs/maintainers/` | somebody working on this repository |
| `docs/generated/` | nobody by hand — written by a `pnpm` script |

## Code conventions

Formatting is Biome's job (`pnpm lint`). Beyond it: prefer explicit over implicit, don't commit
commented-out code, and export at file level rather than through barrel re-exports of internal
helpers. An unused import, variable, or parameter is an error rather than a warning, so dead code
has to be removed or justified in the change that adds it.

## Pull requests

- Keep a PR to one thing. For a large or contentious change, opening an issue first saves work;
  for a bug fix or a small improvement, just send the PR.
- `pnpm verify` should pass.
- Fill in the [PR template](.github/pull_request_template.md) — a summary and what you ran is
  usually enough.
- For a non-trivial change, update the closest user-facing document, the type contract, and the
  tests that define the behaviour.

By contributing you agree your contributions are licensed under the project's
[Apache License 2.0](LICENSE).
