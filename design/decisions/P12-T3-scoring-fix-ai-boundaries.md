---
id: P12-T3
title: "Scoring, fixes, and AI boundaries"
status: accepted
date: 2026-07-15
---

# ADR P12-T3: Scoring, Fixes, and AI Boundaries

## Context

SDK reuse will invite requests for a score, automatic fixes, and AI explanations. Those are valid
future areas, but mixing them into the first public SDK would blur the most important property of
FairUX: deterministic, explainable findings.

The absence of findings is not proof that a page is fair or safe. A score that hides coverage gaps
would mislead users.

## Decision

- P12 exposes deterministic findings, not a safety score.
- Any future score must be versioned and displayed alongside coverage.
- A zero-finding report must not be described as safe.
- Future fix suggestions must distinguish `safe` edits from `review-required` remediation.
- AI is optional augmentation, not part of the deterministic core finding contract.
- AI findings are non-blocking by default and carry provenance such as provider, model, policy
  version, confidence, and blocking status.
- AI-generated edits are never applied automatically by `--write`.

## Consequences

- CI remains reproducible and explainable.
- Future score and remediation work has a defined boundary instead of leaking into P12.
- Consumer products can add AI or policy overlays at the application layer without changing FairUX
  core semantics.

## Non-goals

Implementing score, coverage, fixes, AI providers, baselines, suppressions, or journey analysis.
