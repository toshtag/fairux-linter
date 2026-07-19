---
id: P4-T1
title: SARIF 2.1.0 mapping for FairUX
status: accepted
date: 2026-06-02
---

# ADR P4-T1: SARIF 2.1.0 mapping for FairUX

## Context

`FairUxReport` is the public-API envelope, but it's a FairUX-specific shape. To plug into the
broader ecosystem — GitHub code scanning, IDE analyzers, security/quality dashboards — we need
**SARIF 2.1.0** output. This ADR fixes the mapping so that:

- A FairUX finding lands in the right SARIF surface (results, locations, fingerprints).
- Baseline transfer is preserved (a fingerprint that's stable across HTML/DOM runtimes in our
  own `FairUxReport` must also be stable as a SARIF `fingerprints` entry).
- The disclaimer ("not a legal judgment") survives the round-trip — important for a UX-risk
  signaller that integrates into pipelines run by people who don't read READMEs.

P4-T2 implements; this ADR fixes the contract.

## Decision

### 1. Where the reporter lives

`toSarif()` ships in **`@fairux/report`** next to `toJson` / `toMarkdown`. No new package: SARIF
is just another rendering of the same `FairUxReport`, and `@fairux/report` is already browser-safe
(pure formatting, no Node deps). A new package would invent surface area for nothing.

### 2. SARIF version and shape

- Target **SARIF 2.1.0** only (the only practically-consumed version).
- API:
  - `toSarif(report: FairUxReport, options?: SarifOptions): string` — JSON string (matches the
    `toJson`/`toMarkdown` idiom).
  - `toSarifObject(report, options?): SarifLog` — exported for callers that need to post-process.
- `SarifOptions.rules?: ReadonlyArray<RuleMeta>` — optional rule registry. When provided,
  populates `tool.driver.rules[]` with full metadata (id, name, shortDescription, helpUri).
  When omitted, `rules[]` is **derived from findings** (id only, no metadata) — usable but
  thinner. Documented trade-off; users who want rich rules pass `allRules` from `@fairux/rules`.

### 3. `tool.driver` — and the disclaimer's home

```json
{
  "tool": {
    "driver": {
      "name": "FairUX",
      "version": "<report.toolVersion>",
      "informationUri": "https://github.com/toshtag/fairux-linter",
      "shortDescription": { "text": "Rule-based UX risk-signal linter." },
      "fullDescription": {
        "text": "FairUX does not provide legal judgments. Findings are UX risk signals for review."
      },
      "rules": [ … ]
    }
  }
}
```

The disclaimer goes in `tool.driver.fullDescription.text` — that field is what GitHub code
scanning and most SARIF viewers surface above the results list. It's also mirrored into
`run.properties.fairux.disclaimer` so machine consumers that ignore `fullDescription` still see it.

### 4. Result mapping

For each `Finding`:

| FairUX | SARIF |
|---|---|
| `ruleId` | `result.ruleId` |
| `severity` | `result.level` (mapping below) |
| `title + description` | `result.message.text` (description; title used as the markdown header in `result.message.markdown` if we ever add markdown — non-goal here) |
| `evidence[0]` | `result.locations[0]` (additional evidence → `result.relatedLocations[]`) |
| `fingerprint` | `result.fingerprints.fairuxV1` |
| `confidence`, `category`, `whyItMatters`, `recommendation`, `references` | `result.properties.fairux.*` |

### 5. Severity mapping — analyzer-honest, not integration-friendly

```
high   → "error"
medium → "warning"
low    → "note"
info   → "note"
```

This is the **conservative, analyzer-honest** choice. SARIF level "error" means GitHub code
scanning will block PRs by default for findings we graded `high`. That is intended: if a team
disagrees with our grading, **the right place to re-grade is `fairux.config.ts`'s `rules[id].severity`** — not the SARIF mapping. Re-grading in fairux is severity-override semantics; re-grading at the SARIF boundary would silently desynchronize the JSON envelope and the SARIF output.

### 6. Location mapping — runtime-aware

A FairUX finding's primary `evidence` carries a `locator` and optionally a `source`:

- **Static HTML runtime** (the only adapter today): `evidence.source.{file,startLine,startColumn}` is usually present →
  ```json
  "physicalLocation": {
    "artifactLocation": { "uri": "<file>" },
    "region":          { "startLine": <n>, "startColumn": <c> }
  }
  ```
- **DOM/Figma runtimes** (per ADR P3-T1, `source` is undefined by design) → emit a
  **`logicalLocation`** instead:
  ```json
  "logicalLocations": [{
    "name": "<css selector | path | figma nodeId>",
    "kind": "<css | path | figma | ast>",
    "fullyQualifiedName": "<locator type>:<value>"
  }]
  ```
  SARIF requires *some* location; logicalLocation lets us be honest that the position is
  selector-based, not file-based, without faking source lines.

### 7. Fingerprints — the magic

`result.fingerprints` is a `Record<string, string>`. We emit one entry:

```json
"fingerprints": { "fairuxV1": "<finding.fingerprint>" }
```

`fairuxV1` is the *version key* (versioning the *fingerprint algorithm*, not SARIF). When we
ever change the fingerprint inputs, we'll emit BOTH `fairuxV1` and `fairuxV2` for a transition
window so downstream baselines don't silently invalidate — that pattern is SARIF's recommended
approach to fingerprint evolution. This ADR commits us to that discipline.

### 8. Run-level metadata

```json
"properties": {
  "fairux": {
    "schemaVersion": "<report.schemaVersion>",
    "runtime":       "<report.input.runtime>",
    "generatedAt":   "<report.generatedAt>",
    "disclaimer":    "FairUX does not provide legal judgments. Findings are UX risk signals for review."
  }
},
"invocations": [{ "executionSuccessful": true }]
```

`invocations[].executionSuccessful: true` is required by some validators; emit it unconditionally.

### 9. Validation posture

- **Non-goal**: bundling a SARIF JSON-Schema validator. That adds a heavy dep and false-positives
  on every SARIF schema dot release.
- **Goal**: a snapshot test of `toSarif(sampleReport)` (like the existing JSON/Markdown snapshots)
  *plus* an integration test that runs the output through the GitHub code-scanning ingest path
  (acceptance criteria for P4-T2, not a runtime dep).

## Consequences

- **Positive**: a single command (`fairux scan ... --format sarif`, configurable in CLI as a
  follow-up) drops a CI-friendly artifact that GitHub / IDEs / SARIF dashboards understand.
- **Positive**: fingerprints become portable — a `high` finding in static-HTML CI and the same
  underlying issue caught later by a DOM-runtime scan share `fingerprints.fairuxV1` and therefore
  the same baseline entry. (This is the operational payoff of ADR P3-T1's "shapes are identical
  across runtimes" decision.)
- **Negative**: high-severity findings will block PRs in GitHub code scanning by default. This
  is intentional but needs README documentation when SARIF output ships.
- **Negative**: `properties.fairux.confidence` is FairUX-specific, so consumers that read only
  the SARIF standard will lose confidence info. We accept this; the alternative (faking SARIF
  confidence via level) corrupts the standard.

## Alternatives considered

- **Map severity to "warning" uniformly**: rejected. Loses information; teams who *want* hard
  failure on dark patterns lose the mechanism. Severity-mapping must reflect the analyzer's
  grading; teams re-grade in config.
- **Embed FairUX disclaimer in every `result.message`**: rejected — UI noise. The
  `tool.driver.fullDescription` placement is where SARIF viewers expect it.
- **Implement a SARIF schema validator inside `@fairux/report`**: rejected — heavy dep, brittle.
  P4-T2 acceptance test uses the real GitHub ingest path instead.
- **Separate `@fairux/sarif` package**: rejected. SARIF is just another reporter on the same
  `FairUxReport`; the existing browser-safe `@fairux/report` is the right home.

## Non-goals (this ADR)

SARIF suppressions, `taxonomies`, `threadFlows`, multiple `runs` per file, conversion *from*
SARIF, bundled SARIF schema validator, an automatic GitHub Actions workflow that uploads the
artifact (that's a docs task once `--format sarif` lands).
