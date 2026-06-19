# FairUxReport JSON schema

`fairux scan <path> --format json` emits a **`FairUxReport`**. This envelope is a **public API**:
tools (CI, editors, dashboards, the SARIF reporter) read it, so it changes under the discipline
described in [Versioning](#versioning) below.

> FairUX does not provide legal judgments. Findings are UX risk signals for review.

## Top-level shape

```jsonc
{
  "schemaVersion": "0.1",          // bumped only on breaking changes (see Versioning)
  "toolVersion": "0.3.0",          // the CLI/tool version that produced this report
  "generatedAt": "2026-06-19T08:00:00.000Z", // ISO-8601 UTC
  "input": {
    "file": "checkout.html",       // optional; present for the HTML adapter, absent for DOM
    "runtime": "html"              // "html" | "dom" | "ast" | "figma"
  },
  "summary": {
    "total": 3,
    "bySeverity": { "info": 0, "low": 1, "medium": 1, "high": 1 }
  },
  "findings": [ /* Finding[] — see below */ ]
}
```

| Field | Type | Notes |
|---|---|---|
| `schemaVersion` | `"0.1"` | The schema version, **not** the tool version. Currently `0.1`. |
| `toolVersion` | `string` | The producing tool's version (free-form). Informational; do not gate on it. |
| `generatedAt` | `string` | ISO-8601 timestamp. Non-deterministic — exclude it when snapshotting. |
| `input.file` | `string?` | Source file when known (HTML adapter). **Absent** for runtimes with no file (DOM). |
| `input.runtime` | `Runtime` | Which adapter produced the report. |
| `summary.total` | `number` | Equals `findings.length`. |
| `summary.bySeverity` | `Record<Severity, number>` | Counts per severity; all four keys always present. |
| `findings` | `Finding[]` | Possibly empty. |

## `Finding`

```jsonc
{
  "id": "consent/checked-checkbox#1",   // unique WITHIN this report (run-scoped)
  "fingerprint": "2b9f0c1d4e6a8b70",    // STABLE across runs — the baseline key
  "ruleId": "consent/checked-checkbox",
  "category": "consent",
  "severity": "medium",                 // "info" | "low" | "medium" | "high"
  "confidence": "high",                 // "low" | "medium" | "high"
  "title": "Pre-checked consent box",
  "description": "A consent checkbox is checked by default.",
  "evidence": [ /* Evidence[] — at least one */ ],
  "whyItMatters": "Pre-checked boxes opt users in without an active choice.",
  "recommendation": "Leave consent boxes unchecked by default.",
  "references": ["https://www.ftc.gov/business-guidance/blog"]  // optional
}
```

### `id` vs `fingerprint` — the important distinction

- **`id`** is unique only *within one report* (`<ruleId>#<n>`). It is **not** stable across runs;
  do not store it or diff on it.
- **`fingerprint`** is the **stable baseline key**: the same underlying issue produces the same
  fingerprint across runs, across small edits, and **across runtimes** (a finding from the static
  HTML adapter and the same finding from the live-DOM adapter share a fingerprint). Dedup, track,
  and baseline on this.

What goes into the fingerprint: `ruleId`, `category`, the primary `evidence` locator, a short
normalized **text hint**, and the rule's **major** version. What is deliberately **excluded**:
the source line (so it's runtime-portable and survives line drift), the severity (so re-grading a
rule via `fairux.config.ts` does **not** move the fingerprint), and the full surrounding text.

> ⚠️ **Locator churn moves the fingerprint.** If a flagged element has no stable `id`, its locator
> falls back to an `:nth-child(...)` path; restructuring nearby markup can change that path and
> therefore the fingerprint. Put stable `id`s on elements you expect FairUX to flag repeatedly.

## `Evidence`

```jsonc
{
  "locator": { "type": "css", "value": "#newsletter" }, // see NodeLocator
  "text": "Email me offers",                            // optional
  "snippet": "<input type=checkbox checked>",           // optional
  "source": { "file": "checkout.html", "startLine": 30, "startColumn": 4 } // optional
}
```

A finding carries **one or more** pieces of evidence; `evidence[0]` is the primary one (used for
the fingerprint and as the SARIF primary location). `source` is **optional and often absent** —
the DOM/Figma runtimes have no source lines by design, so never assume `source.startLine` exists.

### `NodeLocator`

A discriminated union — CSS is just one kind, never the center of the model:

```ts
| { type: "css";   value: string }                                   // e.g. "#id" or an nth-child path
| { type: "path";  value: number[] }                                 // child-index path from the root
| { type: "ast";   file: string; startLine: number; startColumn: number }
| { type: "figma"; nodeId: string }
```

Today's adapters emit `css`. `ast`/`figma` are reserved for future runtimes.

## Enumerations

- **`Severity`**: `"info" | "low" | "medium" | "high"`.
- **`Confidence`**: `"low" | "medium" | "high"` — detection certainty. Distinct from severity, and
  **not** overridable by config (it's a property of the evidence, not team policy).
- **`Category`**: `"consent" | "subscription" | "cancellation" | "scarcity" | "hidden-cost" |
  "visual-asymmetry" | "privacy" | "accessibility" | "obstruction"`.
- **`Runtime`**: `"html" | "dom" | "ast" | "figma"`.

## Versioning

`schemaVersion` is the contract version, independent of `toolVersion`.

- **Additive, non-breaking** changes (new optional field, new enum *value*) do **not** bump
  `schemaVersion`. Consumers MUST tolerate unknown fields and unknown enum values.
- **Breaking** changes (removing/renaming a field, changing a type, making an optional field
  required) bump `schemaVersion` (e.g. `0.1` → `0.2`).
- **Fingerprint algorithm** changes are versioned separately from the schema. The SARIF reporter
  emits the fingerprint under a versioned key (`fairuxV1`); a future change would emit both
  `fairuxV1` and `fairuxV2` during a transition window so baselines don't silently invalidate. See
  the [SARIF mapping design note](./decisions/P4-T1-sarif-mapping.md).

## Determinism (for snapshots / golden files)

The report is deterministic **except** `generatedAt` (wall clock) and `toolVersion` (release).
When snapshot-testing, inject a fixed clock / version or mask those two fields. Everything else —
ordering, ids, fingerprints — is stable for a given input and rule set.

## Related

- [SARIF 2.1.0 mapping](./decisions/P4-T1-sarif-mapping.md) (design note)
- [GitHub Actions guide](./github-actions.md)
- [`fairux.config.ts` contract](./decisions/P2-T1-fairux-config-contract.md) — severity overrides, rule enable/disable (design note)
