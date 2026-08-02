# Contributing to FairUX

Thanks for your interest! FairUX is a rule-based UX-risk linter. Bug reports, fixtures of
real-world dark patterns, rule ideas, and PRs are all welcome.

## Getting started

```bash
pnpm install
pnpm verify   # baseline local checks: lint, build-backed typecheck, tests, runtime safety
```

`pnpm verify` is the baseline local gate. CI additionally checks build-output isolation,
post-build lint, worktree cleanliness, rule governance and catalog integrity, package and
release contracts, both supported Node.js floors, and platform-specific behavior.

Other useful scripts:

```bash
pnpm build              # build all packages
pnpm test               # builds the CLI, then runs the test suite (Vitest) — safe on a clean checkout
pnpm fairux scan <path> # run the CLI against a file
```

## Scope-specific checks

`pnpm verify` is the baseline. Run the checks your change's scope calls for on top of it — not
every check on every PR.

Build output or broad source changes:

```bash
pnpm build
pnpm check:build-output
pnpm lint
pnpm typecheck
pnpm test
```

Documentation changes:

```bash
pnpm check:doc-references
```

It fails when a document names a `pnpm` script or a repository path that is not there. Both have
happened: after the rule-approval flow was removed, the docs went on telling readers to run its check
and to open its packet, and the link checker cannot see either — it reads markdown links, not commands
and bare paths.

When a documentation change touches a paragraph about an issue, also run:

```bash
pnpm check:doc-references --issues
```

It asks GitHub for the state of every issue mentioned near unfinished-sounding wording, or under a
heading that says the section is unfinished, and **reports** — it does not fail. Read what it lists;
most of it is accurate sentences like "R4 is open, and #90 is fixed and unmeasured since". It is
tuned to be worth reading, not to be right.

It is a heuristic three times tuned by being wrong. The unit was a paragraph, which produced eleven
candidates from one bullet list; it is now a window either side of the reference. The phrase list
missed "needs pages this project did not write", which is as plainly unfinished as anything on it.
Then three references to a closed #133 survived anyway, one of them under `## Not implemented yet`
saying nothing unfinished of its own — so the nearest heading counts too, because a heading is a
sentence every paragraph under it inherits. A list of wordings is a list of the ways somebody has
been caught so far.

Note that this paragraph cannot name those two in backticks, because the check would then flag itself.
That is the rule working: a document that needs to mention something no longer there should say so in
prose rather than in the notation a reader would copy and run.

**Adding a hand-written `.mjs` or `.d.mts` counts as a build-output change**, whatever the file does.
Those extensions are what the build emits, so the contract decides by location: they belong in a
`scripts/` directory or `tests/fixtures/`, and anywhere else they are indistinguishable from a stray
artifact. A test helper that reads the filesystem is the usual case — it goes in `scripts/`, not
beside the test.

Rules or governance changes:

```bash
pnpm rules:reviews:check
pnpm rules:catalog:check
pnpm eval:corpus:check
pnpm calibrate:risk-index:check
```

`eval:corpus:check` fails when detection quality moved. If it did, run `pnpm eval:corpus`, read the
diff, and say in the PR what changed and why — see [the corpus README](corpus/README.md).

A change to what a rule detects additionally needs a rule-version bump, an updated review record, and
a regenerated baseline:

```bash
pnpm rules:reviews:update
```

Include the regenerated file in the pull request. No approval workflow, no environment, and no value
copied by hand — a rule change is an ordinary code change and goes through ordinary review.

The requirement is **checked, not asked for**: `rules:reviews:check` compares a digest of every
dictionary pattern, every rule's execution metadata, and every page-context keyword against the one
the baseline records. Editing a pattern without bumping a version used to pass everything; now it
fails with the command that fixes it. See
[rule review](docs/rule-review-workflow.md#the-detection-digest-and-the-hole-it-closes).

Package or release changes:

```bash
pnpm pack:smoke
pnpm pack:smoke:sdk
pnpm api:inventory:check
```

`api:inventory:check` fails when a name leaves the published SDK surface. An addition passes it and
makes `docs/generated/sdk-api-inventory.json` stale — run `pnpm api:inventory` so the new name
arrives as a diff. A removal is a breaking change and needs more than a regenerated artifact.

plus the release-contract command relevant to the changed path
(`test:release-bundle-handoff`, `test:packed-artifact-contract`, `test:scoped-registry-routing`).

PR CI remains the final repository-wide matrix and cleanliness check.

For external RulePack work, start with [RulePack authoring](docs/rule-pack-authoring.md) and the
[external author example](examples/rule-pack-author). Import only the public SDK entry points from
external examples; internal packages are not a public compatibility contract.

## Where information lives

Each kind of information has one authoritative home. Don't copy logs into a document, keep a
parallel task ledger, or restate a contract in a second place — a claim written twice is a claim
that will be corrected once.

| Information | Source of truth |
| --- | --- |
| Where the product is, and what it will not do | [`docs/roadmap.md`](docs/roadmap.md) |
| A contract — report shape, compatibility, platforms, security | the one document under `docs/` that owns it, linked from the roadmap |
| Concrete work to implement | GitHub Issues, or an explicitly owner-directed PR for one-off maintenance |
| What happened | PRs, GitHub Actions, and [`CHANGELOG.md`](CHANGELOG.md) |

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

## Rules of the house

1. **`@fairux/core` and `@fairux/rules` must stay browser-safe.** No Node built-ins, no DOM, no
   parser dependencies — so the same rules can run in a browser extension. This is enforced by
   `scripts/check-runtime-safety.mjs` (part of `pnpm verify`) and by each package's `tsconfig`.
   Anything Node- or parser-specific belongs in an adapter (`@fairux/html`, `@fairux/ast`),
   in `@fairux/config-node`, or in an app.

2. **Findings are risk signals, not verdicts.** No legal/accusatory language ("illegal",
   "malicious", "fraud"). Prefer "may", "review recommended". Detection is deterministic —
   no AI in the engine.

3. **Third-party RulePacks are trusted executable code.** FairUX validates metadata and finding
   output, but it does not sandbox `evaluate()`. Pin and review external RulePack dependencies.

## Code conventions

Formatting is Biome's job (`pnpm lint`). Beyond it:

- Prefer explicit over implicit.
- Don't commit commented-out code.
- Export at file level; avoid barrel re-exports of internal helpers.

## Writing a rule

Aim for **few, explainable, high-precision rules** over many noisy ones. A new rule should:

- live under `packages/rules/src/<category>/`, export a `Rule`, and be registered in `registry.ts`;
- put match phrases in `dictionary.ts` (**English + Japanese**; never use the `/g` or `/y` flag);
- ship **positive, negative, and Japanese** fixtures — the negative cases (no false positive)
  matter most;
- scope itself when context-dependent (`appliesTo` page contexts, or local-container checks) to
  avoid firing on unrelated pages.

The JSON output (`FairUxReport`) is a **public API** — additive changes only; see
[`docs/fairux-report-schema.md`](docs/fairux-report-schema.md).

## Pull requests

- One concrete work item per PR. Link the Issue when one exists; agree on non-trivial new
  features or bug fixes in an Issue first. Maintainer-directed one-off maintenance needs no
  after-the-fact Issue — write `None — owner-directed maintenance` in the template instead.
- Keep PRs focused; conventional-commit-style messages (`feat(rules): …`, `docs: …`) are
  appreciated.
- `pnpm verify` must pass, plus the [scope-specific checks](#scope-specific-checks) for what you
  changed. PR CI remains the final repository-wide matrix and cleanliness check.
- Fill in the [PR template](.github/pull_request_template.md).
- For a non-trivial change, update the closest user-facing document, the type contract, and the
  tests that define the behavior. Don't add a standalone design record; if this repository ever
  develops a concrete, recurring need for one, that decision can be made then.

By contributing you agree your contributions are licensed under the project's
[Apache License 2.0](LICENSE).
