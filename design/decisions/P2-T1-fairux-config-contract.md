---
id: P2-T1
title: fairux.config.ts contract
status: accepted
date: 2026-05-28
---

# ADR P2-T1: `fairux.config.ts` contract

## Context

v0 ships fixed defaults. Real teams need to tune FairUX without forking:

- **silence noisy rules** (a rule that doesn't fit their product),
- **override severity** to match their risk posture,
- **extend keyword dictionaries** with brand/locale-specific terms,
- **set output defaults** (format / path).

Constraints that must not break:

- `@fairux/core` and `@fairux/rules` stay **browser-safe** (no Node, no fs, no config loading).
- The `FairUxReport` JSON stays a **public API**.
- **No config present ⇒ behavior identical to today** (hard requirement; tested).
- Detection stays **deterministic** (no `/g`/`/y` patterns; no remote/dynamic behavior).

This ADR fixes the *contract*. Implementation is P2-T2.

## Decision

### 1. File, discovery, loading

_(Current spec — revised by P10-T1; see the Historical note at the end of this section.)_

- **Auto-discovery loads only `fairux.config.json`** (data, never executed). Discovery walks from
  the scan target's directory up to the **boundary** — the repo root (nearest `.git`), else the
  nearest `package.json`, else the start directory — and adopts the nearest safe JSON. Both the
  candidate and the boundary are real-path'd, so a symlinked ancestor can't pull in an
  out-of-project config; an existing-but-unsafe nearest JSON (symlink/irregular, oversized, or
  outside the boundary) is a **fail-closed error**, not a fallthrough.
- **Executable config (`.ts/.mjs/.js/.cjs`) loads only via an explicit `--config <path>`** — it is
  trusted code, run with a stderr warning *before* import. An executable config seen during
  auto-discovery is reported (warning), never auto-run, even when a JSON is adopted elsewhere.
- `.json` is parsed directly; `--config` executables export the config as `default`. `--ignore-config`
  skips discovery entirely.
- **Loading is a Node/CLI concern** and lives in `apps/cli` (or a future `@fairux/config`),
  never in core/rules. `.ts` support uses a lightweight runtime loader (`jiti`), dynamically
  imported so the JSON/no-config path never loads it.

> **Historical note.** The original (2026-05) contract auto-discovered *all* formats
> (`fairux.config.{ts,mjs,js,json}`) upward to the repo root and ran `.ts/.js/.mjs` via the loader.
> P10-T1 (2026-06) found this let a scanned, possibly untrusted repo's `fairux.config.ts` execute
> arbitrary code, and replaced it with the JSON-only auto-discovery above. The schema/merge/validation
> sections below are unchanged.

### 2. Schema (the *type* lives in `@fairux/core`; it is browser-safe — just an interface)
```ts
type Severity = "info" | "low" | "medium" | "high";

interface RuleOverride {
  enabled?: boolean;
  severity?: Severity;        // confidence is intentionally NOT overridable (see §3)
}

interface FairuxConfig {
  configVersion?: 1;                                   // forward-compat marker
  includeExperimental?: boolean;                       // default false
  rules?: Record<string, boolean | RuleOverride>;      // ruleId → false | overrides
  dictionary?: Partial<Record<"en" | "ja", Record<string, string[]>>>; // additive keyword groups
  output?: { format?: "json" | "markdown"; path?: string };
}
```

### 3. Merge & precedence semantics
- **Enablement**: `rules[id] === false` (or `{ enabled: false }`) disables a rule. Experimental
  rules still require `includeExperimental: true` **or** an explicit `{ enabled: true }`.
- **Severity**: effective severity = `rules[id].severity ?? rule.meta.defaultSeverity`.
  **Confidence is NOT overridable** — it expresses detection certainty (a property of the
  evidence), not team policy. Letting teams inflate confidence would corrupt the signal.
- **Severity override must not change fingerprints.** Fingerprints already exclude severity, so
  baselines stay stable when a team re-grades a rule. (This is why severity is safe to override.)
- **Dictionary**: user groups are **merged additively** into the built-ins (concatenated per
  locale + group). User entries are **literal substrings**: escaped and compiled to RegExp with
  **no `/g`/`/y` flag** (preserving the stateless-pattern invariant). Regex entries are a non-goal
  (see below) to avoid ReDoS and surprise.
- **Absent config ⇒ no-op.** The resolver returns defaults unchanged.

### 4. Core API impact (designed here, built in P2-T2)
- `ScanOptions` gains `ruleOverrides?: Record<string, RuleOverride>`; `scan()` applies
  enablement and severity override **centrally** (rules never read config).
- A `resolveConfig(config): { ruleOverrides; dictionary; includeExperimental; output }` helper
  lives in the CLI/config layer and maps `FairuxConfig` → `ScanOptions`.
- `createFinding` emits the effective (overridden) severity; the fingerprint is unaffected.

### 5. Validation
- Unknown `ruleId` in `rules` ⇒ **warning, not error** (rules get renamed; don't hard-fail).
- Invalid severity value or malformed config shape ⇒ `CONFIG_ERROR`.

## Consequences

- **Positive**: teams tune without forking; core/rules stay browser-safe (config is resolved
  into `ScanOptions` by the CLI); baselines stay stable across severity re-grading.
- **Negative**: `.ts` config adds a transpile-loader dependency in the CLI; the config shape
  becomes a public API and needs `configVersion` discipline going forward.

## Alternatives considered

- **JSON-only** (no `.ts`): simpler loading but loses typed authoring + comments. Chosen
  compromise: support both; `.json` needs no loader, `.ts` is opt-in.
- **Per-rule config inside `RuleMeta`**: rejected — keeps team *policy* (config) separate from
  rule *definition* (code).
- **Plugins / custom rules from config**: deferred to a separate ADR — large surface
  (sandboxing, API stability) that would dominate this task.

## Non-goals (v0.1)

Custom rules / plugins; regex (vs literal) dictionary entries; per-directory cascading config;
remote config; locale-driven *output* (output is English-only, and detection already merges all
locales, so a config `locale` would be inert today).
