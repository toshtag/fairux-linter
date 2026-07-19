# FairUxReport JSON schema

`fairux scan <path> --format json` emits a **`FairUxReport`**. This envelope is a **public API**:
tools (CI, editors, dashboards, the SARIF reporter) read it, so it changes under the discipline
described in [Versioning](#versioning) below.

> FairUX does not provide legal judgments. Findings are UX risk signals for review.

## Single report shape (`FairUxReport`)

```jsonc
{
  "kind": "single", // "single" | "batch"
  "schemaVersion": "0.1", // bumped only on breaking changes (see Versioning)
  "toolVersion": "<cli-version>", // the CLI/tool version that produced this report (e.g. "0.1.0")
  "generatedAt": "2026-06-19T08:00:00.000Z", // ISO-8601 UTC
  "input": {
    "file": "checkout.html", // optional; present for the HTML adapter, absent for DOM
    "runtime": "html", // "html" | "dom" | "ast" | "figma"
  },
  "summary": {
    "total": 3,
    "bySeverity": { "info": 0, "low": 1, "medium": 1, "high": 1 },
  },
  "findings": [
    /* Finding[] — see below */
  ],
}
```

## Batch report shape (`FairUxBatchReport`)

```jsonc
{
  "kind": "batch", // "single" | "batch"
  "schemaVersion": "0.1", // bumped only on breaking changes (see Versioning)
  "toolVersion": "<cli-version>", // the CLI/tool version that produced this report (e.g. "0.1.0")
  "generatedAt": "2026-06-19T08:00:00.000Z", // ISO-8601 UTC
  "inputs": [
    // Input metadata for each scanned file
    {
      "file": "pages/checkout.html",
      "runtime": "html",
    },
    {
      "file": "components/Button.tsx",
      "runtime": "ast",
    },
    {
      "runtime": "figma", // Figma may not have a file
      "figmaFile": "Design System",
    },
  ],
  "summary": {
    "total": 7,
    "bySeverity": { "info": 1, "low": 2, "medium": 3, "high": 1 },
    "byRuntime": {
      "html": {
        "total": 3,
        "bySeverity": { "info": 0, "low": 1, "medium": 1, "high": 1 },
      },
      "ast": {
        "total": 2,
        "bySeverity": { "info": 0, "low": 1, "medium": 1, "high": 0 },
      },
      "figma": {
        "total": 2,
        "bySeverity": { "info": 1, "low": 0, "medium": 1, "high": 0 },
      },
    },
  },
  "reports": [
    // One FairUxReport per input (without kind/schemaVersion/toolVersion/generatedAt)
    {
      "input": {
        "file": "pages/checkout.html",
        "runtime": "html",
      },
      "summary": {
        "total": 3,
        "bySeverity": { "info": 0, "low": 1, "medium": 1, "high": 1 },
      },
      "findings": [
        // Finding[] with namespaced IDs: "0:consent/checked-checkbox#1"
        {
          "id": "0:consent/checked-checkbox#1",
          "fingerprint": "2b9f0c1d4e6a8b70",
          "batchOccurrenceId": "9a1c2e3f4b5d6078",
          "ruleId": "consent/checked-checkbox",
          "category": "consent",
          "severity": "medium",
          "confidence": "high",
          "title": "Pre-checked consent box",
          "description": "A consent checkbox is checked by default.",
          "evidence": [
            {
              "locator": { "type": "css", "value": "#newsletter" },
              "text": "Email me offers",
              "snippet": "<input type=checkbox checked>",
              "source": {
                "file": "pages/checkout.html",
                "startLine": 30,
                "startColumn": 4,
              },
            },
          ],
          "whyItMatters": "Pre-checked boxes opt users in without an active choice.",
          "recommendation": "Leave consent boxes unchecked by default.",
          "references": ["https://www.ftc.gov/business-guidance/blog"],
        },
      ],
    },
    // ... more reports for other inputs
  ],
}
```

### Single report fields

| Field                | Type                       | Notes                                                                              |
| -------------------- | -------------------------- | ---------------------------------------------------------------------------------- |
| `kind`               | `"single"`                 | Report discriminator. Always `"single"` for single reports.                        |
| `schemaVersion`      | `"0.1"`                    | The schema version, **not** the tool version. Currently `0.1`.                     |
| `toolVersion`        | `string`                   | The producing tool's version (free-form). Informational; do not gate on it.        |
| `generatedAt`        | `string`                   | ISO-8601 timestamp. Non-deterministic — exclude it when snapshotting.              |
| `input.file`         | `string?`                  | Source file when known (HTML adapter). **Absent** for runtimes with no file (DOM). |
| `input.runtime`      | `Runtime`                  | Which adapter produced the report.                                                 |
| `summary.total`      | `number`                   | Equals `findings.length`.                                                          |
| `summary.bySeverity` | `Record<Severity, number>` | Counts per severity; all four keys always present.                                 |
| `findings`           | `Finding[]`                | Possibly empty.                                                                    |

### Batch report fields

| Field                | Type                       | Notes                                                                       |
| -------------------- | -------------------------- | --------------------------------------------------------------------------- |
| `kind`               | `"batch"`                  | Report discriminator. Always `"batch"` for batch reports.                   |
| `schemaVersion`      | `"0.1"`                    | The schema version, **not** the tool version. Currently `0.1`.              |
| `toolVersion`        | `string`                   | The producing tool's version (free-form). Informational; do not gate on it. |
| `generatedAt`        | `string`                   | ISO-8601 timestamp. Non-deterministic — exclude it when snapshotting.       |
| `inputs`             | `Input[]`                  | Metadata for each scanned file/runtime.                                     |
| `summary.total`      | `number`                   | Total findings across all reports.                                          |
| `summary.bySeverity` | `Record<Severity, number>` | Global counts per severity; all four keys always present.                   |
| `summary.byRuntime`  | `Record<Runtime, Summary>` | Per-runtime breakdowns. Each runtime has `total` and `bySeverity`.          |
| `reports`            | `SingleReport[]`           | One single report per input, with namespaced IDs.                           |

#### Batch `Input` shape

```ts
{
  file?: string,           // Source file when known
  runtime: Runtime,        // Which adapter produced the report
  figmaFile?: string,      // Figma file name when runtime is "figma"
}
```

#### Batch `SingleReport` shape

Same as `FairUxReport` but without:

- `kind` (redundant in batch context)
- `schemaVersion` (inherited from batch root)
- `toolVersion` (inherited from batch root)
- `generatedAt` (inherited from batch root)

Finding IDs are namespaced with the input index: `"${inputIndex}:${ruleId}#${n}"`. Batch
findings also carry `batchOccurrenceId`, a stable occurrence key derived from the file path plus
the single-file `fingerprint`.

## `Finding`

```jsonc
{
  "id": "consent/checked-checkbox#1", // unique WITHIN this report (run-scoped)
  "fingerprint": "2b9f0c1d4e6a8b70", // STABLE across runs — the baseline key
  "batchOccurrenceId": "9a1c2e3f4b5d6078", // optional; present in batch reports
  "ruleId": "consent/checked-checkbox",
  "category": "consent",
  "severity": "medium", // "info" | "low" | "medium" | "high"
  "confidence": "high", // "low" | "medium" | "high"
  "title": "Pre-checked consent box",
  "description": "A consent checkbox is checked by default.",
  "evidence": [
    /* Evidence[] — at least one */
  ],
  "whyItMatters": "Pre-checked boxes opt users in without an active choice.",
  "recommendation": "Leave consent boxes unchecked by default.",
  "references": ["https://www.ftc.gov/business-guidance/blog"], // optional
}
```

### `id` vs `fingerprint` vs `batchOccurrenceId` — the important distinction

- **`id`** is unique only _within one report_ (`<ruleId>#<n>`). It is **not** stable across runs;
  do not store it or diff on it. In batch reports it is prefixed with the input index only to avoid
  collisions inside that one batch payload.
- **`fingerprint`** is the **stable baseline key**: the same underlying issue produces the same
  fingerprint across runs, across small edits, and **across runtimes** (a finding from the static
  HTML adapter and the same finding from the live-DOM adapter share a fingerprint). Dedup, track,
  and baseline on this.
- **`batchOccurrenceId`** is present on findings inside a `FairUxBatchReport`. It distinguishes
  repeated copies of the same underlying issue across files while leaving `fingerprint` unchanged
  for cross-run baselines.

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
  "text": "Email me offers", // optional
  "snippet": "<input type=checkbox checked>", // optional
  "source": { "file": "checkout.html", "startLine": 30, "startColumn": 4 }, // optional
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

Today's adapters emit `css` (static HTML / live DOM), `ast` (JSX/TSX source), and `figma` (Figma REST API JSON).

## Enumerations

- **`Severity`**: `"info" | "low" | "medium" | "high"`.
- **`Confidence`**: `"low" | "medium" | "high"` — detection certainty. Distinct from severity, and
  **not** overridable by config (it's a property of the evidence, not team policy).
- **`Category`**: `"consent" | "subscription" | "cancellation" | "scarcity" | "hidden-cost" |
"visual-asymmetry" | "privacy" | "accessibility" | "obstruction"`.
- **`Runtime`**: `"html" | "dom" | "ast" | "figma"`.

## Versioning

`schemaVersion` is the contract version, independent of `toolVersion`.

- **Additive, non-breaking** changes (new optional field, new enum _value_) do **not** bump
  `schemaVersion`. Consumers MUST tolerate unknown fields and unknown enum values.
- **Breaking** changes (removing/renaming a field, changing a type, making an optional field
  required) bump `schemaVersion` (e.g. `0.1` → `0.2`).
- **Fingerprint algorithm** changes are versioned separately from the schema. The SARIF reporter
  emits the fingerprint under a versioned key (`fairuxV1`); a future change would emit both
  `fairuxV1` and `fairuxV2` during a transition window so baselines don't silently invalidate. See
  the [SARIF mapping design note](../design/decisions/P4-T1-sarif-mapping.md).

## Determinism (for snapshots / golden files)

The report is deterministic **except** `generatedAt` (wall clock) and `toolVersion` (release).
When snapshot-testing, inject a fixed clock / version or mask those two fields. Everything else —
ordering, ids, fingerprints — is stable for a given input and rule set.

## Related

- [SARIF 2.1.0 mapping](../design/decisions/P4-T1-sarif-mapping.md) (design note)
- [GitHub Actions guide](./github-actions.md)
- [`fairux.config.ts` contract](../design/decisions/P2-T1-fairux-config-contract.md) — severity overrides, rule enable/disable (design note)
