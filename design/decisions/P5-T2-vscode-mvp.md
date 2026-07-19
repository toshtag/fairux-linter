---
id: P5-T2
title: VSCode extension MVP design
status: accepted
date: 2026-06-19
---

# ADR P5-T2: VSCode extension MVP design

## Context

FairUX should reach engineers **while they edit**, not only at CLI/CI time. The editor surface is
a VSCode extension that shows findings inline. This ADR fixes the **MVP design and its limits**.
It does **not** implement the extension (a follow-up), and it deliberately scopes the MVP small.

What already exists and constrains the design:

- A browser-safe rules engine (`@fairux/core` + `@fairux/rules`) and the `scan()` entry point.
- Two adapters: `@fairux/html` (static HTML) and `@fairux/dom` (live DOM, browser-only).
- A stable `FairUxReport` ([schema](../fairux-report-schema.md)) and `NodeLocator` with a reserved
  `ast` kind that **no adapter emits yet**.

The hard question the MVP must answer honestly: **what can we actually lint in an editor today?**

## Decision

### 1. MVP scope: lint HTML documents only (be honest about JSX/TSX)

The MVP runs FairUX on **`.html` documents** the user has open, using `@fairux/html`. It does
**not** lint JSX/TSX/Vue/Svelte in v1, because there is **no AST adapter** — and faking one by
regex/string-scanning component source would produce exactly the noisy, low-trust findings the
project's constitution forbids. The MVP is small and correct rather than broad and wrong.

> This is the central limitation and it is documented, not hidden: an editor extension that only
> lints `.html` is modest. The AST adapter (`@fairux/ast`, emitting `NodeLocator { type: "ast" }`)
> is the prerequisite for JSX/TSX and is its **own future ADR + task**, explicitly out of scope here.

### 2. Architecture: in-process, reuse the engine; no Language Server (yet)

- Run the engine **in the extension host** (Node) by importing `@fairux/core` + `@fairux/rules` +
  `@fairux/html` directly. No CLI subprocess (avoids spawn/perf cost), no Language Server Protocol
  server (LSP is the right move once we support project-wide, multi-language analysis — overkill
  for an HTML-only MVP).
- Trigger on open / save / edit (debounced) of `.html` documents.

### 3. Findings → `vscode.Diagnostic` (the Problems panel mapping)

Each `Finding` becomes one `vscode.Diagnostic`:

| FairUX | VSCode `Diagnostic` |
|---|---|
| `evidence[0].source.{startLine,startColumn}` | `range` (1-based FairUX line → 0-based VSCode `Position`; widen to the token/line when only a line is known) |
| `severity` | `DiagnosticSeverity`: `high → Error`, `medium → Warning`, `low → Information`, `info → Hint` |
| `title` + `description` | `message` |
| `ruleId` | `code` (with `target` → the rule's `helpUri`/references when present) |
| `"FairUX"` | `source` |
| `whyItMatters` / `recommendation` | `relatedInformation` (or appended to the message) |

The `source` (file + line) **must exist** for a diagnostic to anchor — which is exactly why the
MVP uses the HTML adapter (it has source locations) and not the DOM adapter (it doesn't, by
design — ADR P3-T1). Findings whose `source` is absent are dropped from the Problems panel (and
logged), rather than mis-anchored at line 0.

### 4. Config + severity

The extension reads `fairux.config.*` via the same loader path as the CLI (rule enable/disable,
severity overrides — ADR P2-T1), so editor diagnostics match CI. No separate VSCode settings for
rule policy in the MVP (avoids two sources of truth); only ergonomic settings (enable/disable the
extension, debounce ms) live in VSCode settings.

### 5. Explicitly NOT in the MVP

- **No Quick Fixes** (`CodeActionProvider`). Remediation suggestions are the Skill's job (ADR
  P5-T1); editor auto-fix is a later, separate decision (needs careful per-rule fix authoring).
- **No AI.** The extension shows deterministic findings only.
- **No JSX/TSX/Vue/Svelte** (needs the AST adapter).
- **No project-wide scan / LSP** (per-document only in v1).

## Consequences

- **Positive**: a working editor surface with low risk — reuses the engine, the HTML adapter, the
  config loader, and the diagnostic model VSCode already has. Diagnostics match CI because both
  read the same rules + config.
- **Positive**: scoping to HTML keeps trust high (real source locations, no guessing).
- **Negative**: HTML-only is a modest MVP; the high-value case (linting React components in place)
  waits on the AST adapter. Documented as the next dependency, not pretended away.
- **Negative**: no Quick Fix means the extension *reports* but doesn't *fix* in v1; acceptable for
  an MVP and consistent with keeping remediation in the Skill.

## Alternatives considered

- **Language Server (LSP) from the start**: rejected for the MVP — heavy for single-document HTML
  linting; revisit when multi-language/project-wide analysis lands.
- **Shell out to the `fairux` CLI**: rejected — subprocess + serialization overhead on every
  keystroke-debounce; importing the browser-safe packages in-process is cleaner.
- **Regex/heuristic JSX scanning to "support React now"**: rejected — produces low-confidence,
  noisy findings that violate the constitution. Wait for a real AST adapter.
- **Ship Quick Fixes in the MVP**: deferred — per-rule fix authoring is a meaningful surface;
  remediation already has a home in the Skill (P5-T1).

## Non-goals (this ADR)

Implementing the extension; the `@fairux/ast` adapter and JSX/TSX support (own ADR + task);
Quick Fixes / CodeActions; LSP; AI; project-wide scanning; publishing to the Marketplace.
