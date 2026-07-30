# Claude Code — Project Instructions

## Project purpose

FairUX is a rule-based, explainable linter for dark patterns and unfair UX. It flags UI that may
distort user decisions — misleading subscriptions, hidden costs, unfair consent, cancellation
friction, scarcity pressure — on static HTML, live DOM, and JSX/TSX, from the CLI, CI (SARIF), a
browser extension, and a VS Code extension. Detection is deterministic and local: no AI, no
network in the core.

## Product boundaries

- Findings are **UX risk signals for human review**, never verdicts. No legal, fraud, or site
  safety conclusions, and no accusatory language ("illegal", "malicious", "fraud") in rules,
  findings, or docs. Prefer "may", "review recommended".
- Zero findings are **not** proof that a page is fair, legal, or safe. Never present them as such.
- Purchase Guard-style products are separate applications. URL, TLS, domain, redirect, and
  reputation signals belong in their namespace at the application layer, never inside FairUX
  findings. This is a checkable contract: `tests/unit/external-consumer-boundary.test.ts` and
  [`design/decisions/P18-T1-purchase-guard-architecture-contract.md`](design/decisions/P18-T1-purchase-guard-architecture-contract.md).

## Package and public API boundaries

- Public packages: `fairux` (CLI, configured but not yet released) and `@fairux/sdk` (published
  on npm's `next` dist-tag). The public SDK surface is `@fairux/sdk`, `@fairux/sdk/html`, and
  `@fairux/sdk/dom` only.
- Everything else (`@fairux/core`, `@fairux/rules`, adapters, reporters) is internal and not a
  compatibility contract.
- The JSON report (`FairUxReport`) is a public API — additive changes only. See
  [`docs/fairux-report-schema.md`](docs/fairux-report-schema.md).

## Deterministic core constraints

- `@fairux/core` and `@fairux/rules` must stay **browser-safe**: no Node built-ins, no DOM, no
  parser dependencies. Enforced by `pnpm check:runtime-safety`.
- Same normalized input + same scanner policy → same findings. No AI in the engine.
- Builds write only into `dist/`; `pnpm check:build-output` is fail-closed on anything else.
- Dictionary regexes never use the `/g` or `/y` flag. Match phrases ship in English and Japanese.
- Follow `design/rules/coding-style.md` for code style.

## Third-party RulePack trust boundary

External RulePacks are **trusted executable JavaScript**, not sandboxed plugins. FairUX validates
metadata and finding output but does not sandbox `evaluate()`. Never auto-download or inject
unknown pack code; pin and review external pack dependencies.

## Workflow

1. Read the GitHub Issue for the task.
2. Confirm scope and acceptance criteria before writing code.
3. Create a branch.
4. Implement.
5. Run focused tests for the changed area.
6. Run full verification (below).
7. Open a PR (template in `.github/pull_request_template.md`). One issue = one PR.
8. Do not merge without explicit user approval.

Commit messages are conventional-commit style (`feat(rules): …`, `docs: …`), lowercase after the
type. Do not add a `Co-authored-by` trailer.

## Verification

```sh
pnpm verify   # lint → typecheck → test → runtime-safety; what CI runs first
```

Full pre-PR sweep when the change touches build output, rules, or release paths:

```sh
pnpm build && pnpm check:build-output && pnpm lint && pnpm typecheck && pnpm test
pnpm check:runtime-safety
pnpm rules:reviews:check && pnpm rules:reviews:check:approved && pnpm rules:catalog:check
pnpm pack:smoke && pnpm pack:smoke:sdk
```

## Documentation sources of truth

| Information | Source of truth |
| --- | --- |
| Current product state | [`docs/status.md`](docs/status.md) |
| Mid/long-term roadmap | [`docs/roadmap.md`](docs/roadmap.md) |
| Concrete work items | GitHub Issues |
| Durable design decisions | [`design/decisions/`](design/decisions/) |
| Implementation results | PRs and GitHub Actions |

Do not duplicate status or run evidence across documents; link to the source instead.
