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
  "rulePacks": [
    { "id": "@fairux/builtin", "version": "0.1.0" }, // optional provenance
  ],
  "summary": {
    "total": 3,
    "bySeverity": { "info": 0, "low": 1, "medium": 1, "high": 1 },
  },
  "coverage": {
    // What the scan was able to check — see Coverage below
    "capabilities": {
      "available": ["structure", "text", "attributes", "source-location", "style-hints"],
      "unavailable": ["source-range", "dom-state", "computed-style", "viewport", "interaction", "journey", "form", "network"],
    },
    "summary": { "total": 13, "eligible": 11, "executed": 9, "skipped": 2 },
    "rules": [
      { "ruleId": "consent/checked-checkbox", "executed": true },
      { "ruleId": "consent/accept-reject-visual-imbalance", "executed": false, "skipReason": "not-enabled" },
      {
        "ruleId": "obstruction/modal-close-visibility",
        "executed": false,
        "skipReason": "missing-capability",
        "missingCapabilities": ["dom-state"],
      },
    ],
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
  "rulePacks": [
    { "id": "@fairux/builtin", "version": "0.1.0" }, // optional provenance
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
| `rulePacks`          | `RulePackReference[]?`     | Optional rule-pack provenance for SDK/pack-based scans.                            |
| `summary.total`      | `number`                   | Equals `findings.length`.                                                          |
| `summary.bySeverity` | `Record<Severity, number>` | Counts per severity; all four keys always present.                                 |
| `coverage`           | `ScanCoverage?`            | What the scan was able to check. Present on every report `scan()` produces; see [Coverage](#coverage). |
| `findings`           | `Finding[]`                | Possibly empty. Excludes anything an inline directive accepted.                    |
| `suppressed`         | `AppliedSuppression[]?`    | Findings an inline `fairux-disable-next-line` accepted, with the reason given. **Absent**, not empty, when none did. |
| `suppressionDiagnostics` | `SuppressionDiagnostic[]?` | Directives that were malformed or matched nothing. **Absent** when there are none. |
| `externalFilters`    | `ExternalFilterRecord[]?`  | What a `--suppress` or `--baseline` file removed, in the order the files ran. **Absent** when none was applied — see [External filters](#external-filters). |

`summary.total` counts what `findings` holds, so a suppressed finding is excluded from both. What was
suppressed is never dropped silently — it moves to `suppressed`, with its reason.

**Every output format shows it**, not only JSON. Markdown and HTML render a "Suppressed by an inline
directive" section and a "Directive problems" section; SARIF publishes both under
`run.properties.fairux` as `inlineSuppressions` and `suppressionDiagnostics`. They are deliberately
not SARIF suppressions: a FairUX directive is applied inside the scanner and leaves no result to
suppress, so what is published is the record rather than a suppression object. A page whose only
finding was turned off on line 4 used to render on every non-JSON surface exactly like a page with
no directive at all.

```ts
type AppliedSuppression = {
  ruleId: string;
  reason: string;
  /** 1-based line the directive comment sits on; it applies to the line after. */
  line: number;
  /**
   * `fingerprints.fairuxV1` of the finding that was removed.
   *
   * The rule and the line say which directive fired; only this says which finding. It is also what
   * lets a baseline tell "this entry's finding is gone" from "this entry's finding is hidden by a
   * directive" — without it, `--baseline` reported an inline-suppressed finding as safe to delete.
   */
  fingerprint?: string;
};

type SuppressionDiagnostic = {
  line: number;
  kind: "malformed" | "unused";
  message: string;
};
```

### Batch report fields

| Field                | Type                       | Notes                                                                       |
| -------------------- | -------------------------- | --------------------------------------------------------------------------- |
| `kind`               | `"batch"`                  | Report discriminator. Always `"batch"` for batch reports.                   |
| `schemaVersion`      | `"0.1"`                    | The schema version, **not** the tool version. Currently `0.1`.              |
| `toolVersion`        | `string`                   | The producing tool's version (free-form). Informational; do not gate on it. |
| `generatedAt`        | `string`                   | ISO-8601 timestamp. Non-deterministic — exclude it when snapshotting.       |
| `inputs`             | `Input[]`                  | Metadata for each scanned file/runtime.                                     |
| `rulePacks`          | `RulePackReference[]?`     | Optional rule-pack provenance for SDK/pack-based scans.                     |
| `summary.total`      | `number`                   | Total findings across all reports.                                          |
| `summary.bySeverity` | `Record<Severity, number>` | Global counts per severity; all four keys always present.                   |
| `summary.byRuntime`  | `Record<Runtime, Summary>` | Per-runtime breakdowns. Each runtime has `total` and `bySeverity`.          |
| `reports[].coverage` | `ScanCoverage?`            | Per input, never rolled up — two inputs in one batch can differ.            |
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

**Same means same, and it is one type.** A batch entry is a `FairUxInputReport` — the exact shape a
single report carries, minus the five envelope fields above. That is not a convention a reader has to
trust: `FairUxReport extends FairUxInputReport`, and the CLI builds a batch entry by *removing* the
envelope fields rather than by listing the ones it wants.

The listing form is what failed. For one release the batch envelope was assembled by copying `input`,
`summary`, `coverage`, and `findings` and nothing else, so `fairux scan page.html` reported that an
inline directive had turned a rule off and `fairux scan .` did not. Every per-input field added after
that list was written would have been dropped the same way. `suppressed`,
`suppressionDiagnostics`, and `aiAugmentation` are not rolled up and cannot be — a reason belongs to
the line it was written on.

`reports[].input` and `inputs[]` are both `FairUxReportInput`, `figmaFile` included, so a reader does
not have to index one against the other.

`figmaFile` is the Figma REST file name, present only when `runtime` is `figma`. A `.figjson` path is
whatever somebody named the export; this is what the file is called in Figma. It was documented here
and reachable by no code path at all until the adapter's `metadata.title` was carried into the report.

Finding IDs are namespaced with the input index: `"${inputIndex}:${ruleId}#${n}"`. Batch
findings also carry `batchOccurrenceId`, a stable occurrence key derived from the file path plus
the single-file `fingerprint`.

`externalFilters` sits on the batch root, not on `reports[]`. A filter file is applied to the run
rather than to a file: an entry names a fingerprint, and which input produced it is a fact about the
scan.

## External filters

`findings` is what a run **reported**. `externalFilters` is what makes that different from what the
run **detected**.

`--suppress` and `--baseline` both read a file and subtract from the report. Every run already
accounted for that on stderr — which entry applied, which lapsed, which matched nothing. stderr is
the one place a stored artifact does not keep. A pipeline that uploads the JSON, a SARIF upload that
lands in a code-scanning tab, and a reviewer opening the file six months later all saw a short list
of findings and no way to learn that a file had made it short.

| Field                | Type                       | Notes                                                                       |
| -------------------- | -------------------------- | --------------------------------------------------------------------------- |
| `kind`               | `"suppressions" \| "baseline"` | Which filter this record is for.                                        |
| `file`               | `string`                   | The path as it was given on the command line.                               |
| `digest`             | `string`                   | `sha256:<hex>` over the file's bytes. The path says which file was named; this says which version of it ran. |
| `identity`           | `object?`                  | What the file says about itself: `schemaVersion`, and a baseline's `toolVersion` and `createdAt`. |
| `detected`           | `Summary`                  | The count this filter was handed. For the first filter applied, what the scan detected. |
| `reported`           | `Summary`                  | The count this filter left. For the last filter applied, the report's own `summary`. |
| `applied`            | `ExternalFilterEntry[]`    | Entries that removed at least one finding, each with a `count`.             |
| `expired`            | `ExternalFilterEntry[]?`   | Suppressions past their `expiresOn`, which therefore removed nothing.       |
| `unmatched`          | `ExternalFilterEntry[]?`   | Entries naming a finding this scan did not produce.                         |
| `resolved`           | `ExternalFilterEntry[]?`   | Baseline entries whose findings are absent, so the file can shrink.         |

```ts
type ExternalFilterEntry = {
  fingerprint: string;
  ruleId?: string;
  /** Required of a suppression, absent from a baseline, which has no place to put one. */
  reason?: string;
  expiresOn?: string;
  /** Present only on `applied`, where it is at least 1. */
  count?: number;
};
```

The records are ordered as the filters ran: suppressions before baseline, so a finding covered by
both is attributed to the argued one. `reported` of each record is `detected` of the next.

**Expired is not unmatched.** An expired entry matched nothing because it stopped applying, and its
findings are in `findings`. An unmatched entry is one nobody will otherwise remove.

**Where it appears.** JSON carries the whole record. SARIF publishes it under `run.properties.fairux`
as `externalFilters`. Markdown and HTML render a "Removed by a filter file" section naming each file,
its digest, and what it took out. The Risk Index report gains a limitation naming each filter, so a
score or an empty `contributingFindings` computed after subtraction cannot be read as a clean page.

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
  "stepId": "checkout", // journey findings only; see Journey report shape
}
```

A finding carries **one or more** pieces of evidence; `evidence[0]` is the primary one (used for
the fingerprint and as the SARIF primary location). `source` is **optional and often absent** —
the DOM/Figma runtimes have no source lines by design, so never assume `source.startLine` exists.

`source` carries a file, a line, and a column, and never more. Where each *attribute* of a node is
written is a separate thing a scan may record — `UiNode.attributeRanges`, gated on the
`source-range` capability — and it stays on the node rather than travelling into evidence: a
reader needs a place to look, and a report shipping every attribute position of every flagged node
would be paying for an edit nobody asked it to make.

### `NodeLocator`

A discriminated union — CSS is just one kind, never the center of the model:

```ts
| { type: "css";   value: string }                                   // e.g. "#id" or an nth-child path
| { type: "path";  value: number[] }                                 // child-index path from the root
| { type: "ast";   file: string; startLine: number; startColumn: number }
| { type: "figma"; nodeId: string }
```

Today's adapters emit `css` (static HTML / live DOM), `ast` (JSX/TSX source), and `figma` (Figma REST API JSON).

**A `css` value may be a sequence, separated by ` >>> `.** A selector cannot cross a shadow
boundary — `querySelector` does not descend into a shadow root, and no selector syntax a browser
still implements does either. The DOM adapter walks into *open* shadow roots, so a node inside one
needs a locator that says which root each part is resolved against: the first selector is resolved
against the document, and each one after it against the previous match's `shadowRoot`. A locator for
a document with no shadow root has one segment and is exactly the flat selector it has always been,
so a consumer that passes the whole value to `querySelector` is unaffected by this.

A consumer that does meet a multi-segment value and passes the whole string to `querySelector` gets
a thrown `SyntaxError` rather than a match: ` >>> ` is not valid CSS in any engine. That is
deliberate — a wrong element highlighted as if it were the finding is the one failure that cannot be
told apart from success. Split with `splitCssLocator` from `@fairux/core`, which returns a
single-element array for the ordinary case.

Closed shadow roots are not traversed, so nothing ever claims to point inside one. A hop whose host
has no `shadowRoot` is unresolvable, and a consumer must report that rather than falling back to the
host or to the document.

## Enumerations

- **`Severity`**: `"info" | "low" | "medium" | "high"`.
- **`Confidence`**: `"low" | "medium" | "high"` — detection certainty. Distinct from severity, and
  **not** overridable by config (it's a property of the evidence, not team policy).
- **`Category`**: `"consent" | "subscription" | "cancellation" | "scarcity" | "hidden-cost" |
"visual-asymmetry" | "privacy" | "accessibility" | "obstruction"`.
- **`Runtime`**: `"html" | "dom" | "ast" | "figma"`.
- **`CapabilityId`**: `"structure" | "text" | "attributes" | "source-location" | "source-range" |
"dom-state" | "style-hints" | "computed-style" | "viewport" | "interaction" | "journey" | "form" |
"network"`, or a namespaced `"<owner>/<name>"` from an external capability vocabulary.

## Journey report shape (`JourneyReport`)

A journey is scanned through a **separate API** — `scanJourney` in the engine, `scanHtmlJourney` in
`@fairux/sdk/html`, and `fairux scan-journey <file>` on the command line. `scan()` is unchanged and
still takes exactly one document; an API that took either would complicate the input, the output,
and every surface that renders them.

```jsonc
{
  "kind": "journey",
  "schemaVersion": "0.1",
  "toolVersion": "<cli-version>",
  "generatedAt": "2026-08-01T08:00:00.000Z",
  "steps": [
    // In `order`, always — not in the order the caller passed them
    {
      "id": "pricing", // stable across runs, unique within the journey
      "order": 1,
      "url": "/pricing", // or "location" for a screen with no URL
      "report": {
        /* exactly what scan() produces for that document */
      },
    },
  ],
  "findings": [
    /* Finding[] that exist only ACROSS steps — never a copy of a step's own */
  ],
  "summary": { "total": 1, "bySeverity": { "info": 0, "low": 0, "medium": 1, "high": 0 } },
  "stepSummary": { "total": 4, "bySeverity": { "info": 0, "low": 1, "medium": 3, "high": 0 } },
  "coverage": {
    /* what the JOURNEY rules could check; each step's own coverage stays on its report */
  },
}
```

### The two layers are disjoint

`summary` counts the journey's own findings; `stepSummary` rolls up the steps'. They describe
different sets, so they may be added — and a journey rule that re-reported a single step's problem
would make one issue read as two, which is what the split exists to prevent.

### Journey finding identity

- Every piece of a journey finding's evidence carries **`stepId`**. The same locator exists on every
  step, so a locator alone cannot place the finding, and "somewhere in this flow" is not something a
  reader can act on.
- The **step is part of the fingerprint**. The same shape at two points of a flow is two findings —
  "the offer changed at checkout" and "the offer changed at confirmation" are different facts.
- `stepId` is **rejected on the single-document path**, where there are no steps for it to name.
- Severity, confidence, and references behave exactly as they do for a document finding.
- **SARIF**: there is no journey SARIF output yet, and the rule for one is already fixed — a journey
  finding has no physical location of its own, so a reporter must anchor it to its step's file, the
  same way a locator-only result is anchored to the file that was scanned.

### The journey file the CLI reads

`fairux scan-journey <file>` takes a JSON file naming documents already on disk:

```jsonc
{
  "steps": [
    {
      "id": "pricing", // stable across runs, unique within the journey
      "order": 1, // explicit, so a reordered array cannot change the flow
      "file": "pricing.html", // resolved against the JOURNEY FILE, not the working directory
      "url": "/pricing", // or "location" — where the step came from, not an address to fetch
      "actionLabel": "Continue", // what the user did to reach the next step
      "transition": { "kind": "navigation" }, // navigation | in-page | unknown
    },
  ],
}
```

JSON only: an executable journey file would be code loaded to describe an input, and there is nothing
here to compute. A `file` that looks like a URL is **refused with the reason** — the CLI does not
fetch anything or launch a browser. An unknown field is refused rather than ignored, so a `selector`
or `waitFor` that would do nothing cannot read as a supported instruction. A step naming a file that
is not there fails the whole journey before any of it is scanned.

Output is `--format json` or `--format markdown`. SARIF is refused: the identity rule below is fixed
and not implemented. HTML is refused: that report renders one document with one coverage panel, and a
journey has two disjoint layers and a panel per step. There is no `--risk-index`, because how a
journey should score is an open question
([issue #135](https://github.com/toshtag/fairux-linter/issues/135)) and a number shipped ahead of its
answer is harder to withdraw than one that was never printed.

`--fail-on` applies to **both layers**: any finding at or above the threshold, the flow's own or any
step's. A user asking to fail on anything means anything, and a threshold reading one layer would
pass a flow whose every step is broken, or one whose price changes between pages, depending on which
half it was written against.

### What a journey input carries, and what it must not

A step is `{ id, order, document, url?, location?, actionLabel?, transition? }`. **No selectors, wait
conditions, credentials, or browser instructions**: nothing in FairUX drives a browser, and a contract
that accepted driver instructions would imply one exists. The caller supplies documents it already
has.

Refused before any step runs: an empty journey, a duplicate step id, a duplicate order, and a step
with no document. A step that fails takes the journey with it — half a flow reported as a whole one
would say a cancellation path was checked when only its first page was.

Capabilities available to a journey rule are the **intersection** of the steps', plus `journey`. A
capability one step has and another lacks would make a cross-step comparison rest on half the
evidence.

## Coverage

`coverage` says what the scan was **able** to check. A findings list cannot answer that for itself,
least of all an empty one: `total: 0` has always meant both "nothing is wrong here" and "nothing here
was looked at", and this is the field that separates them.

```ts
type ScanCoverage = {
  capabilities: {
    available: CapabilityId[];
    /** The built-in vocabulary plus anything the rule set asked for, minus what was available. */
    unavailable: CapabilityId[];
  };
  summary: {
    total: number; // every rule in the composed set
    eligible: number; // rules the effective configuration enabled
    executed: number; // eligible rules that ran
    skipped: number; // eligible rules that did not — `eligible - executed`
  };
  rules: Array<{
    ruleId: string;
    executed: boolean;
    skipReason?: "not-enabled" | "missing-capability" | "page-context-mismatch";
    /** Required capabilities the input could not supply. Only with `missing-capability`. */
    missingCapabilities?: CapabilityId[];
    /** Optional capabilities the rule ran without — it produced results with less evidence. */
    missingOptionalCapabilities?: CapabilityId[];
  }>;
};
```

**Every rule in the set appears in `rules`**, in the order the scan considered them. The three skip
reasons are three different problems with three different fixes:

- `not-enabled` — the configuration did not turn it on. Not counted as skipped: it was never in the
  running, and counting it as lost coverage would penalise a deliberately narrow configuration.
- `missing-capability` — the input cannot supply something the rule requires, and `missingCapabilities`
  names what. Checked before the page context, because this is a fact about the input regardless of
  what the page turns out to be.
- `page-context-mismatch` — the rule is scoped to page contexts this document does not match.

`missingOptionalCapabilities` appears on a rule that **ran**. Optional capabilities never gate; the
rule produced results with less than the evidence it can use, which is a weaker pass than one with
everything available.

### What coverage is not

- **Not a score.** There is no percentage and no grade. A ratio of executed to total would invite
  exactly the reading this project refuses.
- **Not a correctness claim.** An executed rule is a rule that ran, not a rule that was right.
- **Not a safety claim.** Full coverage with zero findings is still not a statement that a page is
  fair, legal, or safe. See [what FairUX guarantees](security-boundary.md#what-fairux-guarantees).
- **Not comparable across inputs.** Two scans with different capabilities checked different things,
  which is why a batch report keeps coverage per input rather than merging it.

### Where coverage appears

| Output | Where |
| --- | --- |
| JSON | `coverage` on the report, and on each `reports[]` entry of a batch |
| Markdown | a **Coverage** section, before the findings and present when there are none |
| HTML | a coverage panel, per input in a batch |
| SARIF | `run.properties.fairux.coverage` — property-bag data, one run per input |

`fairux rules --runtime <html|dom|ast|figma>` answers the part of this that needs no scan: which
rules an input of that kind could never run, and what they would need.

What each runtime supplies, and how an adapter outside this repository declares its own set, is in
[rule governance](rule-metadata.md#capabilities).

## Risk Index (`RiskIndexReport`)

The Risk Index is **computed from a report**, not emitted by a scan. `computeRiskIndex(report)` takes
a single, batch, or journey report and returns its own document. JSON is canonical; every other
surface displays that document and derives nothing of its own.

**Where the model comes from, and where it does not.** `@fairux/core` holds the shape and no
weights, because weights are policy and the engine holds the contract. The built-in model
implementations — `fairux-risk/1` and `fairux-risk/2` — live beside the rules in the **internal**
`@fairux/rules` workspace package, which is not published; consumers receive them re-exported from
`@fairux/sdk`, and the CLI bundles and resolves the same two. What the numbers mean, and what they
do not, is in [Risk Index](risk-index.md).

Three surfaces reach them three different ways, and only one of them takes a version string:

| Surface | Default model | How to reach `fairux-risk/2` |
| --- | --- | --- |
| `@fairux/core` | none — `status: "unsupported"`, reason `no-model` | pass the model object as `model` |
| `@fairux/sdk` | `fairux-risk/1` | `computeRiskIndex(report, { model: fairuxRiskIndexModelV2 })` |
| `fairux scan --risk-index` | `fairux-risk/1` | `--risk-index-model fairux-risk/2` |

**`modelVersion` does not select a model.** It is a guard: pass it and the call throws unless the
model it was given already has that version. Only the CLI resolves a version string to a model, and
`--risk-index-model` is where it does that. Asking the SDK for
`computeRiskIndex(report, { modelVersion: "fairux-risk/2" })` is an error, not a way to get v2.

The example below is therefore the `no-model` case — a bare `@fairux/core` call. Its `status` is
usually `sufficient` or `insufficient-coverage` once a model is supplied, but `unsupported` is still
reachable with one: a custom model whose `appliesTo` rejects the input returns `unsupported` with
reason `model-not-applicable`.

**`versions.modelVersion` identifies the model, not the outcome.** A supplied model names its
version even when it cannot score the input — `model-not-applicable` carries `score: null` and a
non-null `modelVersion`. Read `status` to learn whether there is a number; `modelVersion` answers
which model was asked, and is `null` only when none was.

```jsonc
{
  "kind": "risk-index",
  "versions": {
    "schemaVersion": "0.1", // the Risk Index schema, independent of FairUxReport's
    "modelVersion": null, // null only when no model was supplied — see below
    "rulePacks": [{ "id": "@fairux/builtin", "version": "0.1.0" }],
    "toolVersion": "0.1.0",
  },
  "generatedAt": "2026-08-01T08:00:00.000Z",
  "status": "unsupported", // "sufficient" | "insufficient-coverage" | "unsupported"
  "score": null, // higher is worse; non-null ONLY when status is "sufficient"
  "confidence": null, // the model's confidence in its score — NOT a coverage ratio
  "reason": { "code": "no-model", "message": "no Risk Index model is implemented in this build" },
  "coverage": {
    "documents": 1,
    "journeySteps": 3, // journey inputs only
    "requiredCapabilities": [],
    "missingCapabilities": [],
    "rules": { "total": 13, "eligible": 11, "executed": 9, "skipped": 2 },
  },
  "contributingFindings": [
    // identity only; sorted by fingerprint so finding order cannot change the report
    {
      "findingId": "consent/checked-checkbox#1",
      "ruleId": "consent/checked-checkbox",
      "fingerprint": "2b9f0c1d4e6a8b70",
      "severity": "medium",
      "confidence": "high",
      "stepId": "checkout", // journey inputs only
    },
  ],
  "limitations": ["…"], // never empty
}
```

### Only one status carries a number

| `status` | `score` | Means |
| --- | --- | --- |
| `sufficient` | a number | A model applied and had enough coverage to answer. |
| `insufficient-coverage` | `null` | A model applies; the scan did not check enough. Check more. |
| `unsupported` | `null` | No model applies, or none is implemented. Ask differently. |

There is **no provisional zero and no midpoint**. Anything numeric returned when coverage is
insufficient would be read, screenshotted, and compared, so the contract makes it impossible rather
than discouraged: `score` and `confidence` are both `null` on every unscored path, and `reason` is
present exactly when they are.

### Coverage is not confidence

How much was checked and how sure a model is about what it found are different questions. Collapsing
them is how a well-covered scan of an ambiguous page ends up reading as certain, so they are separate
fields and neither is derived from the other. `coverage.missingCapabilities` lists what the model
required that some input could not supply — the difference between "we looked and it was clean" and
"we could not look".

### Versions cannot drift

`schemaVersion`, `modelVersion`, `rulePacks`, and `toolVersion` travel together. A caller may pass
`modelVersion` to demand a specific model and is **refused** rather than answered by whatever model
is present: asking for a version is asking for a specific meaning of the number. A model that changes
its weights must change its version, because two incomparable numbers under one name is the failure
this field exists to prevent.

### How it appears on each surface

| Output | Where |
| --- | --- |
| JSON | the canonical `RiskIndexReport` |
| Markdown | `toRiskIndexMarkdown`, showing a number only when the report carries one |
| SARIF | `run.properties.fairux.riskIndex` — **never a result**, because a score is not a finding |
| CLI exit code | unaffected. The exit code is a function of finding severities and `--fail-on`, never of a score. |

Every human surface reads one shared view (`toRiskIndexView`) rather than the report's fields, because
one renderer printing `0` for a null score would undo the contract and nothing about the output would
look wrong.

## `Remediation`

A proposed fix for one finding, in one file. `fairux scan --fix-write` applies the `safe` ones;
nothing applies a `review-required` one. **One built-in rule produces a remediation** —
`consent/checked-checkbox`, removing a pre-checked default from static HTML — and attaching one to a
rule is a rule change that goes through the same review and version bump as any other.

```jsonc
{
  "id": "consent/checked-checkbox#1-uncheck",
  "origin": "rule", // "rule" | "ai"
  "safety": "safe", // "safe" | "review-required"
  "title": "Uncheck the marketing consent box",
  "description": "Removes the checked attribute from the marketing consent checkbox.",
  "rationale": "The attribute is removed and nothing a user reads changes.",
  "file": "checkout.html",
  "fileChecksum": "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
  "edits": [
    {
      "startLine": 30, // 1-based, inclusive
      "startColumn": 34,
      "endLine": 30,
      "endColumn": 42,
      "expected": " checked", // what the range must currently contain
      "replacement": "",
    },
  ],
}
```

### `safe` versus `review-required`

Removing a `checked` attribute is not the same kind of act as rewriting a sentence a user will read.
Deciding which is which at apply time — by whoever happens to be running the command — is how the
second one gets applied by accident, so the classification is in the data and `rationale` is required
for **both**: a `safe` label needs an argument more than a cautious one does.

### An AI-suggested edit can never be `safe`

`origin` is validated against `safety`, and an `ai` remediation claiming to be `safe` is **refused**.
This is what makes "AI-generated edits are never auto-applied" a validation rule rather than a
promise in a document — the gate exists before M6 adds the thing it gates.

### Why each edit repeats what it expects

A range alone is a bet that nothing moved between the scan and the write, and that bet is lost
quietly: the edit lands somewhere plausible and the file is wrong in a way nothing reports. Every
edit carries `expected`; an empty one is an insertion, an absent one is refused. `fileChecksum` is
lowercase hex SHA-256 of the contents the edits were computed against, and any other shape is refused
rather than discovered as a mismatch at write time.

### One file

A remediation spanning several files brings partial application, ordering, and rollback with it.
Pretending otherwise in the schema would make the hard case look supported.

## AI augmentation (`aiAugmentation`)

Optional, advisory, and **never part of `findings`**. No provider ships and no network call exists;
this is the shape one would have to fit.

```jsonc
{
  "aiAugmentation": {
    "advisory": true, // always; a field rather than a comment, so a consumer can assert on it
    "observations": [
      {
        "id": "o1",
        "summary": "The trial CTA does not mention renewal.",
        "detail": "…in the provider's own words",
        "statedConfidence": "high", // the provider's claim about itself — a string, not Confidence
        "relatedRuleId": "subscription/free-trial-without-renewal-disclosure",
        "provenance": {
          "provider": "example",
          "model": "example-1",
          "generatedAt": "2026-08-01T08:00:00.000Z",
          "inputChecksum": "…", // SHA-256 of what was sent
        },
      },
    ],
    "failures": [{ "code": "timeout", "message": "…" }],
  },
}
```

### Three things it cannot do

**It cannot become a finding.** An observation has no `fingerprint`, no `ruleId`, and no `severity` —
the fields a baseline tracks and a build fails on — and a provider that attaches one is refused
rather than trimmed. `statedConfidence` is deliberately a plain string: it is the provider's claim
about itself and must not be comparable with a rule's.

**It cannot fail a build.** `--fail-on` reads findings. A report whose only signal is an observation
exits 0 at every threshold, and a contract test asserts it.

**It cannot leak.** What a provider receives is assembled from an **allowlist** — normalized text,
tag names, and the page contexts FairUX detected — and nothing else. No attributes, because they
carry ids, URLs, and tracking parameters; no file paths. A field added to the model does not appear
in the payload until someone adds it to the allowlist, which is the difference between this and a
redaction step that strips what it already knows to strip.

### And one thing it must do

Fail without taking the scan with it. A provider races a timer; one that throws, hangs, or answers
with something unusable produces a recorded `failures` entry and no observations. A runtime with no
timer refuses to call a provider at all, because an unbounded call to a third party is the one thing
this contract promises never to make.

## Versioning

`schemaVersion` is the contract version, independent of `toolVersion`.

- **Additive, non-breaking** changes (new optional field, new enum _value_) do **not** bump
  `schemaVersion`. Consumers MUST tolerate unknown fields and unknown enum values.
- **Breaking** changes (removing/renaming a field, changing a type, making an optional field
  required) bump `schemaVersion` (e.g. `0.1` → `0.2`).
- **Fingerprint algorithm** changes are versioned separately from the schema. The SARIF reporter
  emits the fingerprint under a versioned key (`fairuxV1`); a future change would emit both
  `fairuxV1` and `fairuxV2` during a transition window so baselines don't silently invalidate. See
  [the GitHub Actions guide](../guides/github-actions.md) for how `fairuxV1` relates to GitHub's own alert
  matching — it is not GitHub's key.

## Determinism (for snapshots / golden files)

The report is deterministic **except** `generatedAt` (wall clock) and `toolVersion` (release).
When snapshot-testing, inject a fixed clock / version or mask those two fields. Everything else —
ordering, ids, fingerprints — is stable for a given input and rule set.

## Related

- [Compatibility and deprecation](compatibility.md) — what may change, and what happens first
- [GitHub Actions guide](../guides/github-actions.md) — SARIF upload, severity mapping, fingerprints
- Configuration (severity overrides, rule enable/disable) — see the README's Configuration section
