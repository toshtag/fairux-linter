# FairUX architecture

## Purpose

FairUX is a rule-based, explainable linter for dark patterns and unfair UX. It flags UI that may
distort user decisions — misleading subscriptions, hidden costs, unfair consent, cancellation
friction, scarcity pressure — on static HTML, live DOM, and JSX/TSX, from the CLI, CI (SARIF), a
browser extension, and a VS Code extension.

This page states the invariants every change is held to, the boundaries between packages, and
where individual design decisions are recorded. For the current product state see
[`docs/status.md`](../status.md); for direction see [`docs/roadmap.md`](../roadmap.md).

## Invariants

- **`@fairux/core` and `@fairux/rules` stay runtime-agnostic and browser-safe.** No Node built-ins,
  no DOM, no parser dependencies, so the same rules run in a browser extension. Enforced by
  `pnpm check:runtime-safety`.
- **`FairUxReport` is a public API.** Additive changes only; anything breaking needs a
  `schemaVersion` bump. See [`docs/fairux-report-schema.md`](../fairux-report-schema.md).
- **Detection is deterministic.** The same normalized input under the same scanner policy produces
  the same findings. Dictionary regexes never use the `/g` or `/y` flag, and match phrases ship in
  English and Japanese.
- **Prefer conservative, explainable findings over broad detection.** Reducing false positives is a
  primary quality goal; a false negative is the cheaper mistake.
- **Findings are UX risk signals, not verdicts.** FairUX detects signals, not intent. No legal,
  fraud, or site-safety conclusions, and no accusatory language ("illegal", "malicious", "fraud")
  in rules, findings, or docs — prefer "may", "review recommended".
- **Zero findings are not proof that a page is fair, legal, or safe.** Never present them as such.
- **AI stays outside the deterministic core.** AI augmentation may exist outside the core and must
  remain separately identified, optional, and non-blocking by default.
- **External RulePacks are trusted executable JavaScript, not sandboxed plugins.** FairUX validates
  metadata and finding output but does not sandbox `evaluate()`. Never auto-download or inject
  unknown pack code; pin and review external pack dependencies.
- **Resist scope expansion.** Strengthen evidence, fixtures, and contracts before adding new
  product surfaces.

## Package boundaries

- `packages/core` — the engine (types, `scan()`, fingerprinting). **Browser-safe.**
- `packages/rules` — the rule set and keyword dictionaries (en/ja). **Browser-safe.**
- `packages/html` · `packages/dom` · `packages/ast` — adapters (static HTML / live DOM / JSX-TSX).
- `packages/report` — JSON, Markdown, and SARIF reporters.
- `packages/sdk` — the public facade.
- `apps/cli` · `apps/chrome-extension` · `apps/vscode-extension` — the surfaces.

Anything Node- or parser-specific belongs in an adapter or an app, never in core or rules.

## Public compatibility boundaries

- Public packages: `fairux` (CLI, configured but not yet released) and `@fairux/sdk` (published on
  npm's `next` dist-tag). The public SDK surface is `@fairux/sdk`, `@fairux/sdk/html`, and
  `@fairux/sdk/dom` only.
- `@fairux/core`, `@fairux/rules`, the adapters, and the reporters are internal and are not a
  compatibility contract.
- The JSON report (`FairUxReport`) is a public API — additive changes only.

## Runtime boundaries

- Purchase Guard-style products are separate applications. URL, TLS, domain, redirect, and
  reputation signals belong in their own namespace at the application layer, never inside FairUX
  findings. This is a checkable contract: `tests/unit/external-consumer-boundary.test.ts` and
  the [Purchase Guard boundary](decisions/purchase-guard-boundary.md) record.
- Builds write only into `dist/`; `pnpm check:build-output` is fail-closed on anything else.

## Decision records

Durable design decisions live in [`decisions/`](decisions/). Each record states the context, the
decision, its consequences, and its non-goals; records are not a status ledger.

| Record | Subject |
| --- | --- |
| [`fairux-config-contract`](decisions/fairux-config-contract.md) | `fairux.config.ts` shape, discovery, and merge semantics |
| [`dom-adapter-contract`](decisions/dom-adapter-contract.md) | Live-DOM adapter and cross-runtime fingerprint stability |
| [`sarif-mapping`](decisions/sarif-mapping.md) | SARIF 2.1.0 mapping for `FairUxReport` |
| [`vscode-extension-mvp`](decisions/vscode-extension-mvp.md) | VS Code extension MVP and its limits |
| [`jsx-tsx-adapter-contract`](decisions/jsx-tsx-adapter-contract.md) | `@fairux/ast` JSX/TSX adapter and what it refuses to claim |
| [`public-sdk-facade`](decisions/public-sdk-facade.md) | What the public SDK exposes, and what stays internal |
| [`rule-pack-contract`](decisions/rule-pack-contract.md) | Versioned RulePack composition contract |
| [`scoring-remediation-ai-boundaries`](decisions/scoring-remediation-ai-boundaries.md) | Scoring, remediation, and AI boundaries |
| [`rule-governance-contract`](decisions/rule-governance-contract.md) | Rule maturity, capability, evidence, and source metadata |
| [`extensible-taxonomy-contract`](decisions/extensible-taxonomy-contract.md) | Extensible category, locale, and page-context IDs |
| [`purchase-guard-boundary`](decisions/purchase-guard-boundary.md) | Where external-consumer signals live relative to FairUX |
