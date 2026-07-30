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

1. Read the GitHub Issue when one exists; otherwise use the owner's explicit instruction as the
   scoped work item.
2. Confirm scope and acceptance criteria before writing code.
3. Create a branch.
4. Implement.
5. Run focused tests for the changed area.
6. Run baseline verification and the applicable scope-specific checks below.
7. Commit the scoped change, following the message conventions below.
8. Run the post-commit cleanliness checks.
9. Open a PR (template in `.github/pull_request_template.md`).
10. Do not merge without explicit user approval.

One concrete work item per PR. Use one GitHub Issue per PR when the work originates from an
Issue or introduces a new product task. For owner-directed one-off maintenance with no existing
Issue, write `None — owner-directed maintenance` in the PR template's Issue field; do not create
bookkeeping-only Issues.

Commit messages are conventional-commit style (`feat(rules): …`, `docs: …`), lowercase after the
type. Do not add a `Co-authored-by` trailer.

## Verification

### Baseline local verification

```sh
pnpm verify   # baseline: lint → build-backed typecheck → tests → runtime-safety
```

This is the baseline local gate, not the full CI matrix. CI additionally checks build-output
isolation, post-build lint, worktree cleanliness, rule governance and catalog integrity, package
and release contracts, both supported Node.js floors, and platform-specific behavior.

### Scope-specific pre-PR checks

Build output or broad source changes:

```sh
pnpm build
pnpm check:build-output
pnpm lint
pnpm typecheck
pnpm test
```

Rules or governance changes:

```sh
pnpm rules:reviews:check && pnpm rules:reviews:check:approved && pnpm rules:catalog:check
```

Package or release changes:

```sh
pnpm pack:smoke && pnpm pack:smoke:sdk
```

plus the relevant release contract commands (`test:release-bundle-handoff`,
`test:packed-artifact-contract`, `test:scoped-registry-routing`).

Run only the checks the change's scope calls for — not every package smoke on every PR. PR CI
remains the final repository-wide matrix and cleanliness check.

### Post-commit cleanliness

After committing the scoped change:

```sh
git diff --exit-code
test -z "$(git status --porcelain)"
```

These commands verify that builds, generators, formatters, and tests did not leave uncommitted
tracked or untracked output.

## Documentation sources of truth

| Information | Source of truth |
| --- | --- |
| Current product state | [`docs/status.md`](docs/status.md) |
| Mid/long-term roadmap | [`docs/roadmap.md`](docs/roadmap.md) |
| Concrete work items | GitHub Issues, or an explicitly owner-directed PR for one-off maintenance |
| Durable design decisions | [`design/decisions/`](design/decisions/) |
| Implementation results | PRs and GitHub Actions |

`docs/status.md` may summarize the current state and link to authoritative PR or Actions
evidence. Do not copy full logs, maintain parallel task ledgers, or duplicate the same mutable
status across multiple planning documents.
