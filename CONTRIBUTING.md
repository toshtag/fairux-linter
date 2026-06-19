# Contributing to FairUX

Thanks for your interest! FairUX is a rule-based UX-risk linter. Bug reports, fixtures of
real-world dark patterns, rule ideas, and PRs are all welcome.

## Getting started

```bash
pnpm install
pnpm verify   # lint → build → typecheck → test → browser-safety check
```

`pnpm verify` is exactly what CI runs. Keep it green.

Other useful scripts:

```bash
pnpm build              # build all packages
pnpm test               # run the test suite (Vitest)
pnpm fairux scan <path> # run the CLI against a file
```

## Project shape

A pnpm + TypeScript monorepo:

- `packages/core` — the engine (types, `scan()`, fingerprinting). **Browser-safe.**
- `packages/rules` — the rule set + keyword dictionaries (en/ja). **Browser-safe.**
- `packages/html` · `packages/dom` · `packages/ast` — adapters (HTML / live DOM / JSX-TSX).
- `packages/report` — JSON / Markdown / SARIF reporters.
- `apps/cli` · `apps/chrome-extension` · `apps/vscode-extension` — the surfaces.

## Two rules of the house

1. **`@fairux/core` and `@fairux/rules` must stay browser-safe.** No Node built-ins, no DOM, no
   parser dependencies — so the same rules can run in a browser extension. This is enforced by
   `scripts/check-runtime-safety.mjs` (part of `pnpm verify`) and by each package's `tsconfig`.
   Anything Node/parser-specific belongs in an adapter (`@fairux/html`, `@fairux/ast`) or an app.

2. **Findings are risk signals, not verdicts.** No legal/accusatory language ("illegal",
   "malicious", "fraud"). Prefer "may", "review recommended". Detection is deterministic —
   no AI in the engine.

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

- Keep PRs focused; conventional-commit-style messages (`feat(rules): …`, `docs: …`) are appreciated.
- `pnpm verify` must pass.
- For non-trivial design choices, add a short note under `design/decisions/`.

By contributing you agree your contributions are licensed under the project's
[Apache License 2.0](LICENSE).
