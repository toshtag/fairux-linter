---
id: P5-T1
title: FairUX Claude Code Skill design
status: accepted
date: 2026-06-19
---

# ADR P5-T1: FairUX Claude Code Skill design

## Context

FairUX has a deterministic, explainable rules engine reachable from the CLI
(`fairux scan <path> --format json`) producing a stable `FairUxReport`
([schema](../../docs/fairux-report-schema.md)). The next agent-facing surface is a **Claude Code Skill**.

The product thesis (from day one) constrains the design hard:

- The Skill is **NOT the product**. The rules engine is. The Skill is a thin operator's manual
  that tells Claude how to _run_ FairUX and _talk about_ its output.
- **AI does not detect.** Detection stays in `@fairux/rules` (deterministic, reviewable). The
  Skill's AI value is **translation and remediation**: explaining a finding in context and
  proposing a concrete fix.
- Keep the constitution's language rules: risk signals, not legal/moral judgments.

This ADR fixes the _design and boundaries_. It does **not** implement the Skill (that's a
follow-up task) — but because the Skill is mostly a `SKILL.md` + a shell script, the design is
nearly the whole artifact, so it is specified concretely here.

## Decision

### 1. Shape and location

A filesystem Skill under the repo, conventional layout:

```
.claude/skills/fairux-review/
  SKILL.md                     # the operator's manual (frontmatter: name, description)
  references/
    rule-taxonomy.md           # the 10 rules: id, category, what each flags
    severity-policy.md         # severity vs confidence; why we don't moralize
    remediation-examples.md    # before/after fixes per category
  scripts/
    run-fairux-scan.sh         # thin wrapper: builds if needed, runs fairux scan --format json
```

The Skill is invoked as `/fairux-review`. It is a **separate artifact** from the
code-pact-managed `.claude/skills/*` files (context/verify/progress) — different directory entry,
no collision.

### 2. What the Skill does (workflow encoded in SKILL.md)

1. Identify the UI artifact(s) under review — a built HTML file, a PR diff touching UI, a pasted
   page. (For source that isn't static HTML yet — JSX/TSX — note the limitation; see §5.)
2. Run `scripts/run-fairux-scan.sh <path>` to get a `FairUxReport` JSON. **Detection is the
   CLI's job**; the Skill never re-derives findings by "reading the UI itself".
3. Parse the report (it's the documented public API). Group by severity.
4. For each finding: explain _why it matters here_ in plain language, then propose a **minimal,
   concrete remediation** (a copy change, an attribute, a layout note) grounded in the finding's
   `recommendation` + `evidence`.
5. Summarize: counts by severity, the disclaimer, and open questions for the human.

### 3. The CLI output is the source of truth (anti-pattern guard)

The single most important rule in `SKILL.md`: **the Skill must base its findings on the CLI
report, not on its own impression of the UI.** If the CLI isn't available/runnable, the Skill
says so and degrades to "manual review against the rule taxonomy" — explicitly labeled as
_not_ an authoritative FairUX scan. This keeps the deterministic engine as the arbiter and the
AI as the explainer.

### 4. AI scope: explain + remediate, never grade

- ✅ Translate a finding for a non-engineer; tie it to the specific page context.
- ✅ Propose a fix (text/markup/structure), as a diff or snippet.
- ❌ Invent findings the rules didn't produce, or suppress findings it disagrees with.
- ❌ Change severity/confidence. (Re-grading is a `fairux.config.ts` decision — ADR P2-T1 — not
  an AI call.)
- ❌ Legal conclusions ("this is illegal/GDPR-violating"). Risk-signal framing only.

### 5. Known limitations (documented, not hidden)

- The CLI scans **static HTML** today. For JSX/TSX/Vue source, there is no AST adapter yet
  (that's the VSCode-MVP track, ADR P5-T2). The Skill should scan built HTML output where
  possible, or fall back to taxonomy-guided manual review **clearly labeled as non-authoritative**.
- The DOM adapter exists but is browser-only; the Skill runs in Claude Code (Node), so it uses
  the **CLI/HTML path**, not the DOM path.
- AI remediation is a suggestion, not a guarantee; the human decides.

### 6. Premium/monetization boundary (scope note, not a commitment)

The original product thesis placed AI explanation/remediation in a _paid_ tier. This ADR does
**not** decide pricing or gating — it only fixes that the Skill is an AI surface that _consumes_
the free deterministic engine. Any future entitlement/credit logic is out of scope here and
must be its own decision. (Kept out of public design per the repo's strategy-free `design/` rule.)

## Consequences

- **Positive**: ships an agent surface with almost no new code — `SKILL.md` + one shell script +
  reference docs. Reuses the CLI and the public JSON contract verbatim.
- **Positive**: the "CLI is the source of truth" rule keeps AI trust-bounded — reproducible
  detection, AI only for the parts AI is good at.
- **Negative**: limited to static HTML until an AST adapter lands; the Skill must be honest about
  that gap rather than papering over it with AI guesses.
- **Negative**: a `SKILL.md` is prose; its guardrails ("don't invent findings") are softer than a
  type system. Mitigated by making the workflow CLI-first and the anti-pattern explicit.

## Alternatives considered

- **Skill calls `@fairux/*` packages directly (no CLI)**: rejected — duplicates the CLI's wiring
  and the JSON contract; the CLI already is the supported entry point.
- **AI does detection (LLM reads the page, finds dark patterns)**: rejected — non-deterministic,
  non-reviewable, contradicts the core thesis. Detection stays in the rules engine.
- **Skill auto-applies fixes**: rejected for v1 — remediation is a _proposal_; the human applies.

## Non-goals (this ADR)

Implementing `SKILL.md`/scripts (follow-up); pricing/entitlement; an AST adapter for JSX/TSX
(ADR P5-T2 territory); auto-applying fixes; posting PR comments (a CI concern, not the Skill).
