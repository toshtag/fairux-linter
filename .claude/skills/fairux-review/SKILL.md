---
name: fairux-review
description: Review UI code, landing pages, consent/subscription/checkout flows, and PR diffs for FairUX UX-risk signals (dark patterns, misleading subscriptions, hidden costs, unfair consent, scarcity pressure). Runs the deterministic fairux CLI and explains/remediates its findings. Use when reviewing UI for dark patterns or "is this UX fair".
---

# FairUX Review

Review UI for **UX risk signals** using the deterministic `fairux` linter, then explain the
findings and propose fixes.

> FairUX does not provide legal judgments. Findings are UX **risk signals** for human review.

## The one rule that matters

**The `fairux` CLI is the source of truth for *what* is flagged. You explain and remediate; you
do not detect.** Do not invent findings the linter didn't produce, and do not silence findings
you personally disagree with. Detection lives in the deterministic rules engine on purpose
(reproducible, reviewable). Your value is translation and concrete fixes — the parts a human
reviewer actually wants help with.

If the CLI cannot run, say so plainly and fall back to a manual review against
[`references/rule-taxonomy.md`](references/rule-taxonomy.md) — and **label it clearly as a
non-authoritative review**, not a FairUX scan.

## Workflow

1. **Identify the artifact.** A built/static `.html` file, a URL's saved HTML, or UI touched by a
   PR diff. (The CLI scans **static HTML** today — for JSX/TSX/Vue source, scan the built HTML
   output if available; otherwise note the limitation, see [Limitations](#limitations).)
2. **Run the linter:**
   ```sh
   scripts/run-fairux-scan.sh <path-to-html>            # JSON (default)
   scripts/run-fairux-scan.sh <path-to-html> markdown   # human-readable
   ```
   It builds the CLI if needed and runs `fairux scan <path> --format <fmt>`.
3. **Read the report.** It's the documented public API — see
   [`docs/fairux-report-schema.md`](../../../docs/fairux-report-schema.md). Group findings by
   `severity` (high → medium → low → info).
4. **For each finding, explain + remediate:**
   - *Explain* `whyItMatters` in the context of this specific page, in plain language.
   - *Propose a minimal, concrete fix* grounded in the finding's `recommendation` and `evidence`
     (a copy change, an attribute, a disclosure near a CTA, a layout note) — ideally as a diff or
     snippet. See [`references/remediation-examples.md`](references/remediation-examples.md).
5. **Summarize:** counts by severity, the disclaimer, and open questions for the human.

## Output format

```
## FairUX review — <artifact>
<N findings — high X, medium Y, low Z, info W>

### High
- <title> (`ruleId`) — why it matters here; suggested fix.
…
### Medium
…

### Open questions
- …

> FairUX does not provide legal judgments. Findings are UX risk signals for review.
```

## Boundaries (do / don't)

- ✅ Explain a finding for a non-engineer; tie it to the page.
- ✅ Propose a fix as a diff/snippet.
- ❌ Invent findings the linter didn't produce, or suppress ones you dislike.
- ❌ Change a finding's `severity`/`confidence`. Re-grading is a `fairux.config.ts` decision
   (see [`references/severity-policy.md`](references/severity-policy.md)), not an AI call.
- ❌ Make legal conclusions ("this is illegal / violates GDPR"). Use risk-signal framing.

## Limitations

- The CLI scans **static HTML**. There is no JSX/TSX/Vue AST adapter yet — scan built HTML, or do
  a clearly-labeled manual review. Don't guess findings from component source.
- A FairUX live-DOM adapter and a browser extension exist, but this Skill runs the **CLI/HTML**
  path (Node), not the DOM path.
- Remediations are **suggestions**; the human decides and applies them.

## References

- [`references/rule-taxonomy.md`](references/rule-taxonomy.md) — the rules, by category.
- [`references/severity-policy.md`](references/severity-policy.md) — severity vs confidence; why we don't moralize.
- [`references/remediation-examples.md`](references/remediation-examples.md) — before/after fixes.
