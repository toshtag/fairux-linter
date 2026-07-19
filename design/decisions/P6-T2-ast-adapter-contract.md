---
id: P6-T2
title: "@fairux/ast adapter contract (JSX/TSX)"
status: accepted
date: 2026-06-19
---

# ADR P6-T2: `@fairux/ast` adapter contract (JSX/TSX)

## Context

FairUX runs on static HTML (`@fairux/html`) and live DOM (`@fairux/dom`). The highest-value
missing surface is **React source** — linting `.jsx/.tsx` in the editor (VSCode MVP, ADR P5-T2)
and in the Skill needs an adapter that turns component source into a `UiDocument` so the existing
rules run unchanged. `NodeLocator` already reserves a `type: "ast"` kind for exactly this.

The hard truth this ADR must confront: **JSX is not HTML.** Much of what FairUX relies on
(attribute *values*, element text, even whether a branch renders) can be a runtime expression the
adapter cannot evaluate. Naively treating JSX like HTML would manufacture confident-looking
findings from values the adapter never actually knew — the exact failure the constitution forbids.
So this ADR is mostly about **what we refuse to claim**, not just what we parse.

This fixes the contract. Implementation is P6-T3.

## Decision

### 1. Package, parser, runtime-safety

- New package `@fairux/ast`. Parses with the **TypeScript compiler API** (`typescript`, already a
  repo dependency) — no Babel. It handles `.tsx`/`.jsx`/`.ts`/`.js` and gives us stable node
  positions for `NodeLocator`.
- The TS parser is a Node-ish dependency, so `@fairux/ast` is an **adapter** (like `@fairux/html`),
  **not** part of the browser-safe set. The runtime-safety guard continues to cover only
  core/rules/dom; `@fairux/ast` may use `typescript` + Node. (The VSCode extension host is Node, so
  this is fine for the editor surface.)
- `parseSource(code: string, options: { file?: string; jsx?: boolean }): UiDocument` with
  `runtime: "ast"`.

### 2. What maps to a `UiNode`

- Each **JSX element** (`<div>`, `<button>`, `<MyComponent>`) → one `UiNode`.
  - **Intrinsic** lowercase elements (`div`, `button`, `input`) → `tag` = the name.
  - **Component** elements (capitalized, `<Foo>`) → `tag` = lowercased component name, plus
    `attributes["data-fairux-component"] = "Foo"`. Rules key off intrinsic tags, so components are
    largely opaque (see §6) — recorded but rarely actionable in v1.
- `locator`: `{ type: "ast", file, startLine, startColumn }` from the TS node position.
- `source`: the same `{ file, startLine, startColumn }` (AST *does* have source — unlike DOM).

### 3. Attributes — static-only, with an "unknown" sentinel

This is the crux.

- **String literal** attr (`className="primary"`, `type="checkbox"`) → `attributes[name] = value`.
- **Boolean shorthand** (`checked`, `disabled`) → `attributes[name] = true` (matches HTML semantics).
- **Expression** attr (`checked={isOn}`, `className={cx(...)}`, `aria-label={t('close')}`) → the
  value is **unknown at parse time**. The adapter records the attribute *presence* with a sentinel:
  `attributes[name] = true` is **wrong** (it would assert e.g. "checked"), so instead we **omit the
  value** and record the key in a side channel: `attributes["data-fairux-dynamic"]` =
  space-separated list of attr names whose values are expressions. Rules that need a *value* (e.g.
  `checked-checkbox` needs to know it's actually checked) treat a dynamic attr as **not known true**
  → they do not fire. This is the safe default: **unknown ≠ true.**

### 4. Text — static segments only

- Static JSX text and string-literal `{"..."}` children contribute to `directText`/`subtreeText`.
- Expression children (`{label}`, `{count} left`) are **not** evaluated; they contribute nothing
  to text (no guessing). A node whose visible text is entirely dynamic has empty text — rules that
  match on copy simply won't fire on it. Documented: copy-based rules under-report on dynamic text
  (a false-negative, which the constitution prefers over a false-positive).

### 5. Confidence ceiling for AST findings

Because attribute values and text can be dynamic, **the AST runtime cannot raise confidence to
`high` on its own**. The adapter sets a per-document ceiling: any finding produced on an AST
document is capped at `confidence: "medium"`. (Implementation: applied centrally where the report
is assembled for the AST runtime, not inside each rule.) Rationale: a finding from source we only
partially understand should never present as certain.

### 6. Components, control flow, props — explicit non-goals

- **No cross-component analysis.** `<PricingCard plan={x} />` is opaque; the adapter does not
  resolve `PricingCard`'s implementation. Findings live within a single file's JSX.
- **No control-flow evaluation.** `{cond && <Modal/>}`, `.map(...)`, ternaries → the adapter
  includes the JSX it can see structurally but never decides whether a branch renders.
- **No prop/variable resolution.** `const label = "Accept"; <button>{label}</button>` → text is
  dynamic (unknown); not resolved in v1. (A future ADR could add intra-file constant folding.)

### 7. Fingerprints / cross-runtime

AST findings use `locator: ast` (file + line + column) — which **does** participate in the
fingerprint (unlike DOM, where it was excluded for source-portability). AST and HTML findings for
"the same" UI will therefore generally **not** share a fingerprint (different locator kind, and
JSX≠HTML structurally). That's acceptable: AST baselines are their own track, keyed to source
positions. We do not promise AST↔HTML baseline transfer.

## Consequences

- **Positive**: React teams get in-editor FairUX on the structural, high-signal rules
  (pre-checked literal `checked`, accept-only consent JSX, scarcity string copy, bundled consent),
  reusing every existing rule with zero rule changes.
- **Positive**: the "unknown ≠ true" + medium-confidence-ceiling decisions keep AST findings
  trustworthy — the adapter under-reports rather than fabricates.
- **Negative**: dynamic-heavy components yield few findings. A page that's all `{expr}` may scan
  nearly empty. Documented, not hidden — and the right answer for those is the DOM adapter (run it
  in the browser) or scanning built HTML, not guessing from source.
- **Negative**: a new `typescript`-based adapter to maintain; component/control-flow blindness.

## Alternatives considered

- **Babel instead of the TS compiler API**: rejected — `typescript` is already a dependency and
  gives types + positions; avoids a second parser.
- **Evaluate simple expressions (constant folding, literal ternaries)**: deferred to a future ADR.
  Tempting but expands scope and risk; v1 stays "static literals only".
- **Treat expression attributes as their last static guess / as `true`**: rejected outright — this
  is the fabrication failure mode. Unknown must read as unknown.
- **Let AST findings reach `high` confidence**: rejected — source we only partly understand must
  not present as certain.

## Non-goals (this ADR)

Implementing the adapter (P6-T3); cross-component / control-flow / prop resolution; constant
folding; Vue/Svelte SFCs; raising AST confidence above medium; AST↔HTML fingerprint transfer.
