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

For external RulePack work, start with [RulePack authoring](docs/rule-pack-authoring.md),
[RulePack testing](docs/rule-pack-testing.md), and the
[external author example](examples/rule-pack-author). Import only the public SDK entry points from
external examples; internal packages are not a public compatibility contract.

## Where information lives

Each kind of information has one authoritative home. `docs/status.md` may summarize the current
state and link to authoritative PR or Actions evidence; don't copy full logs, maintain parallel
task ledgers, or duplicate the same mutable status across multiple planning documents.

| Information | Source of truth |
| --- | --- |
| Current product state | [`docs/status.md`](docs/status.md) |
| Mid/long-term roadmap | [`docs/roadmap.md`](docs/roadmap.md) |
| Concrete work to implement | GitHub Issues, or an explicitly owner-directed PR for one-off maintenance |
| Architecture and design decisions | [`docs/architecture/`](docs/architecture/README.md) |
| Implementation results | PRs and GitHub Actions |

## Project shape

A pnpm + TypeScript monorepo:

- `packages/core` — the engine (types, `scan()`, fingerprinting). **Browser-safe.**
- `packages/rules` — the rule set + keyword dictionaries (en/ja). **Browser-safe.**
- `packages/html` · `packages/dom` · `packages/ast` — adapters (HTML / live DOM / JSX-TSX).
- `packages/report` — JSON / Markdown / SARIF reporters.
- `apps/cli` · `apps/chrome-extension` · `apps/vscode-extension` — the surfaces.

## Rules of the house

1. **`@fairux/core` and `@fairux/rules` must stay browser-safe.** No Node built-ins, no DOM, no
   parser dependencies — so the same rules can run in a browser extension. This is enforced by
   `scripts/check-runtime-safety.mjs` (part of `pnpm verify`) and by each package's `tsconfig`.
   Anything Node/parser-specific belongs in an adapter (`@fairux/html`, `@fairux/ast`) or an app.

2. **Findings are risk signals, not verdicts.** No legal/accusatory language ("illegal",
   "malicious", "fraud"). Prefer "may", "review recommended". Detection is deterministic —
   no AI in the engine.

3. **Third-party RulePacks are trusted executable code.** FairUX validates metadata and finding
   output, but it does not sandbox `evaluate()`. Pin and review external RulePack dependencies.

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
- `pnpm verify` must pass. Also run the scope-specific checks documented in
  [CLAUDE.md](CLAUDE.md) when changing build output, rules, packaging, workflows, or release
  paths. PR CI remains the final repository-wide matrix and cleanliness check.
- Fill in the [PR template](.github/pull_request_template.md).
- For non-trivial design choices, add a short record under `docs/architecture/decisions/`.

By contributing you agree your contributions are licensed under the project's
[Apache License 2.0](LICENSE).
