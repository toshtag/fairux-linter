---
id: P3-T1
title: DOM adapter contract (`@fairux/dom`)
status: accepted
date: 2026-05-28
---

# ADR P3-T1: DOM adapter contract (`@fairux/dom`)

## Context

v0 ships `@fairux/html` (parse5 → `UiDocument`) — a Node-side adapter for *static* HTML. The next
runtime is a **live browser DOM** (the seed for the eventual Chrome extension). We need a
contract for `@fairux/dom` such that:

- All existing rules run **unchanged** (rules never import a runtime).
- `@fairux/core` and `@fairux/rules` remain **runtime-agnostic and browser-safe** (no Node, no
  parser deps).
- `FairUxReport` and `fingerprint` semantics are **stable across runtimes** wherever
  determinism is achievable.

This ADR fixes the *contract*. Implementation is P3-T2 and the Manifest V3 shell is P3-T3.

## Decision

### 1. Package and runtime-safety boundary

- New package `@fairux/dom`. Browser-only.
- `tsconfig.json`: `"lib": ["ES2022", "DOM"]`, `"types": []`. DOM types are allowed here (and
  only here); Node types are not.
- `scripts/check-runtime-safety.mjs` continues to forbid Node built-ins / parser imports in
  `@fairux/core`, `@fairux/rules`. It does NOT scan `@fairux/dom` (which legitimately uses DOM)
  — but `@fairux/dom` MUST NOT import Node either. A dedicated guard rule covers that.

### 2. Public API

```ts
export interface ParseDomOptions {
  /** Recorded in `metadata.url`; used as the "file" surrogate in source-shaped fields. */
  url?: string;
  /** Limit scanning to a subtree (a modal/banner). Defaults to `document.documentElement`. */
  root?: Element;
}

export function parseDocument(doc: Document, options?: ParseDomOptions): UiDocument;
```

`parseDocument` produces a `UiDocument` with `runtime: "dom"` and the **same `UiNode` shape**
used by the HTML adapter. A rule cannot tell which adapter produced its input.

### 3. Snapshot semantics (point-in-time, no observation)

`parseDocument` walks the tree once and snapshots. Subsequent DOM mutations are NOT reflected;
to rescan, call it again. No MutationObserver, no live updates. **Why**: keeps scans
deterministic, makes fingerprints stable, mirrors the HTML adapter's semantics.

### 4. Node mapping — sameness, with three honest differences

The walker produces a `UiNode` per element. The shape is identical to the HTML adapter's,
with these well-defined differences:

a. **`source` is `undefined`.** The DOM has no source line/column. Rules and reporters MUST
   already treat `source` as optional (the HTML adapter sometimes omits it too). Fingerprints
   that include `sourceStartLine` will use the empty string for DOM-originated findings —
   acceptable, because the `locator` carries the disambiguating information for runtimes that
   lack source.

b. **Boolean attributes prefer properties.** `<input type="checkbox" checked>` may have its
   `checked` reflected as a property change (e.g. user clicked it). The DOM adapter reads
   *properties* for the known boolean set (`checked`, `disabled`, `readonly`, `required`,
   `selected`, `multiple`, `open`, `hidden`, …) and *attributes* otherwise, then normalizes
   the property's `true`/`false` (or attribute presence) to the `Record<string, string | true>`
   shape rules already expect. This is the point of difference where DOM is more truthful
   than HTML (it reflects user state); rules benefit silently.

c. **Locators use the same algorithm as HTML.** Prefer `#id` for a safe id, otherwise the
   `tag:nth-child(k)` path. A live DOM finding and its static-HTML twin therefore share a
   locator and (with identical text) the same fingerprint — baselines transfer.

### 5. Accessibility

`accessibility.name` follows the same best-effort precedence as the HTML adapter:
`aria-label` > resolved `aria-labelledby` > `alt` (for `img`/`area`/`input[type=image]`).
No use of the full WAI-ARIA Accessible Name Computation in v1 — promotion is a follow-up ADR.

### 6. Text fields and normalization

`directText` / `subtreeText` / `normalizedText` are computed identically (NFKC → lowercase →
whitespace-collapse → trim, via `@fairux/core`'s `normalizeText`). Critically:

- The CJK-space collapse limitation noted in ChatGPT review applies equally to both adapters.
  Fixing it (CJK inter-character space removal) MUST be a `@fairux/core` change, not an adapter
  change, so DOM and HTML stay aligned.

### 7. Shadow DOM, iframes

- **Open shadow roots**: traversed and inlined into the parent's subtree as if they were
  regular children. Their nodes get normal `UiNode`s. The `metadata` of the document gains a
  boolean `containsShadow` (informational, not gating).
- **Closed shadow roots**: untouchable by design; skipped silently.
- **Iframes (same-origin or cross-origin)**: not traversed in v1. A page can host hostile or
  third-party iframes; scanning them is a separate trust decision and a future ADR.

### 8. `pageContexts` detection

`detectPageContexts(rootText, titleText)` currently lives in `@fairux/html`. **Decision**:
**move it to `@fairux/core`** (it operates on normalized strings — already browser-safe — and
both adapters need it). The HTML adapter re-exports from core for backward compat. P3-T2
performs the move.

### 9. Performance posture (v0)

Eager materialization (same as the HTML adapter): one walk, build all texts, return.
Acceptable for ordinary pages. Streaming / lazy materialization is a non-goal until measured.

### 10. Computed style — explicit NON-GOAL for v1

`UiNode` will NOT gain a `computedStyle` field in P3-T2. The experimental visual rules
(`accept-reject-visual-imbalance`, `modal-close-visibility`) continue to read inline
`style`/`class` only — a deliberate constraint so all surfaces share the same heuristic
quality. Promoting visual rules with real computed style is a separate ADR (and will need
careful fingerprint-stability work because computed values vary by viewport).

## Consequences

- **Positive**: every existing rule will work on the live DOM with zero changes. Findings on a
  page open in the browser share fingerprints with their static-HTML twins — a CI baseline
  produced from static HTML transfers to a live-DOM panel finding, and vice versa.
- **Positive**: extracting `detectPageContexts` into core removes a hidden coupling and makes
  the contract symmetric.
- **Negative**: source location is unavailable from DOM. Rules that lean on `source` get
  poorer evidence on DOM findings (the locator still carries the position).
- **Negative**: snapshot semantics means a finding can describe a state the user has already
  navigated past. We accept this; live re-scanning is the integrator's responsibility.

## Alternatives considered

- **`@fairux/core` provides a single tree adapter with runtime hooks**: rejected — couples the
  core to a tree-builder; per-runtime packages keep core minimal.
- **MutationObserver-backed continuous scanning**: rejected for v1 — non-deterministic and
  cost-heavy. A separate decision when there's a real consumer.
- **Computed style as `UiNode.computedStyle`**: rejected for v1 (see §10).

## Non-goals (this ADR)

Iframes, closed shadow roots, MutationObserver, computed style on `UiNode`, full WAI-ARIA
Accessible Name Computation, lazy/streaming materialization, third-party-origin scanning.
