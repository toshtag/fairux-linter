---
id: vscode-extension-mvp
legacy_id: P5-T2
title: VS Code extension MVP design
status: accepted
date: 2026-06-19
---

# VS Code extension MVP design

## Context

FairUX should reach engineers **while they edit**, not only at CLI/CI time. The editor surface is
a VS Code extension that shows findings inline. This record fixes the MVP design and its limits.

> **Implementation note (2026-07-31):** the extension MVP and the JSX/TSX adapter are implemented.
> The original decision scoped the MVP to HTML only, because no AST adapter existed yet; that
> boundary was widened once the [JSX/TSX adapter contract](jsx-tsx-adapter-contract.md) was accepted
> and `@fairux/ast` shipped. The scope below is the current one.

What the design builds on:

- A browser-safe rules engine (`@fairux/core` + `@fairux/rules`) and the `scan()` entry point.
- Three adapters: `@fairux/html` (static HTML), `@fairux/dom` (live DOM, browser-only), and
  `@fairux/ast` (static JSX/TSX source, emitting `NodeLocator { type: "ast" }`).
- A stable `FairUxReport` ([schema](../../fairux-report-schema.md)).

The hard question the MVP must answer honestly: **what can we actually lint in an editor, without
manufacturing findings from values we never knew?**

## Decision

### 1. MVP scope: HTML and static JavaScript/TypeScript source

The MVP runs FairUX on open documents whose language is one of:

- `html` — parsed by `@fairux/html`
- `javascript`, `javascriptreact`, `typescript`, `typescriptreact` — parsed by `@fairux/ast`

The adapter is selected from the document's language id, exactly as the CLI selects it from the file
extension. Constraints inherited from the AST adapter:

- JSX/TSX analysis is **static only**. Dynamic attribute values and dynamic text are never asserted.
- AST findings are **capped at medium confidence**, applied centrally in `scan()`, not per rule.
- Vue and Svelte are out of scope — they need their own adapters.

> **Original decision.** The MVP was first scoped to `.html` only, because faking JSX support by
> regex/string-scanning component source would produce exactly the noisy, low-trust findings the
> project's invariants forbid. The scope widened only when a real AST adapter existed, not before.

### 2. Architecture: in-process, reuse the engine; no Language Server

- Run the engine **in the extension host** (Node) by importing `@fairux/core`, `@fairux/rules`,
  `@fairux/html`, and `@fairux/ast` directly. No CLI subprocess (avoids spawn/serialization cost on
  every keystroke-debounce), and no Language Server Protocol server — LSP is the right move once
  project-wide, cross-file analysis exists, which this MVP does not do.
- Trigger on open / save / edit (debounced) of supported-language documents.

### 3. Findings → `vscode.Diagnostic` (the Problems panel mapping)

Each `Finding` becomes one `vscode.Diagnostic`:

| FairUX                                       | VS Code `Diagnostic`                                                                                          |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `evidence[0].source.{startLine,startColumn}` | `range` (1-based FairUX line → 0-based VS Code `Position`; widen to the token/line when only a line is known) |
| `severity`                                   | `DiagnosticSeverity`: `high → Error`, `medium → Warning`, `low → Information`, `info → Hint`                 |
| `title` + `description`                      | `message`                                                                                                    |
| `ruleId`                                     | `code` (with `target` → the rule's `helpUri`/references when present)                                        |
| `"FairUX"`                                   | `source`                                                                                                     |
| `whyItMatters` / `recommendation`            | `relatedInformation` (or appended to the message)                                                            |

The `source` (file + line) **must exist** for a diagnostic to anchor. Both editor adapters provide
one; the DOM adapter does not, by design (see the [DOM adapter contract](dom-adapter-contract.md)),
which is why it has no editor role. Findings whose `source` is absent are dropped from the Problems
panel and logged, rather than mis-anchored at line 0.

### 4. Config + severity

The extension reads `fairux.config.*` via the same loader path as the CLI (rule enable/disable,
severity overrides — see the [config contract](fairux-config-contract.md)), so editor diagnostics
match CI. No separate VS Code settings for rule policy (avoids two sources of truth); only ergonomic
settings (enable/disable the extension, debounce ms) live in VS Code settings.

### 5. Explicitly NOT in the MVP

- **No Quick Fixes** (`CodeActionProvider`). Editor auto-fix is a later, separate decision — it
  needs careful per-rule fix authoring.
- **No AI.** The extension shows deterministic findings only.
- **No Vue / Svelte.**
- **No project-wide scan / LSP** (per-document only).

## Consequences

- **Positive**: HTML and static JSX/TSX are linted through the same rules and the same config as
  CI, so editor diagnostics and pipeline results agree.
- **Positive**: reuses the engine, the adapters, the config loader, and the diagnostic model VS Code
  already has — low risk, no new evaluation surface.
- **Negative**: JSX/TSX findings are static-only and confidence-capped. Values a component computes
  at runtime stay invisible; that is a deliberate false-negative preference.
- **Negative**: no Vue/Svelte and no project-wide analysis; cross-file patterns are not detectable.
- **Negative**: no Quick Fix means the extension _reports_ but doesn't _fix_; acceptable, and
  consistent with keeping remediation a human decision.

## Alternatives considered

- **Language Server (LSP) from the start**: rejected — heavy for single-document linting; revisit
  when project-wide analysis lands.
- **Shell out to the `fairux` CLI**: rejected — subprocess + serialization overhead on every
  keystroke-debounce; importing the browser-safe packages in-process is cleaner.
- **Regex/heuristic JSX scanning to "support React now"**: rejected — produces low-confidence, noisy
  findings that violate the project's invariants. The scope waited for a real AST adapter.
- **Ship Quick Fixes in the MVP**: deferred — per-rule fix authoring is a meaningful surface of its
  own, and findings already carry a written remediation hint.

## Non-goals

Quick Fixes / CodeActions; LSP; AI; Vue and Svelte support; project-wide or cross-file scanning;
publishing to the Marketplace.
