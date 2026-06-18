# Using FairUX in GitHub Actions

FairUX emits **SARIF 2.1.0** (`--format sarif`), which GitHub code scanning understands. This
guide shows how to surface FairUX findings as code-scanning alerts on pull requests.

> FairUX does not provide legal judgments. Findings are UX risk signals for review.

## Start non-blocking

**Introduce FairUX as advisory first.** Uploading SARIF to GitHub code scanning shows findings
as alerts on the PR's *Security* tab and inline on the diff — it does **not** fail the job. That
is the right way to start: the team sees the signal, builds trust, and tunes the rules before
anything blocks a merge. Promote to blocking later (see the last section).

The job below scans a built site and uploads SARIF. The `fairux scan` step uses
`continue-on-error` so a non-zero exit never red-Xes the workflow, and the upload step always
runs.

```yaml
name: FairUX

on:
  pull_request:

# Required for github/codeql-action/upload-sarif to write code-scanning results.
permissions:
  contents: read
  security-events: write

jobs:
  fairux:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm build

      # Scan a static HTML artifact and write SARIF. continue-on-error keeps this advisory:
      # findings show up as code-scanning alerts, but the job stays green.
      - name: Run FairUX
        continue-on-error: true
        run: pnpm fairux scan ./dist/index.html --format sarif > fairux.sarif

      # Always upload, even if the scan step reported findings.
      - name: Upload SARIF
        if: always()
        uses: github/codeql-action/upload-sarif@v3
        with:
          sarif_file: fairux.sarif
          category: fairux
```

Notes:

- `category: fairux` keeps FairUX results in their own code-scanning category, so they don't
  collide with other analyzers (ESLint, CodeQL, etc.) uploading SARIF to the same repo.
- Scan whatever HTML your build produces. For multiple pages, scan each and upload several SARIF
  files (give each a distinct `category`), or concatenate findings upstream — FairUX scans one
  file per invocation today.
- Severity maps **`high → error`, `medium → warning`, `low`/`info` → `note`** (see
  [the SARIF ADR](../design/decisions/P4-T1-sarif-mapping.md)). To re-grade a rule for your team,
  use `fairux.config.ts` (`rules[id].severity`) — **not** the workflow — so the JSON and SARIF
  outputs stay in sync.

## How baselines work (and their limits)

GitHub code scanning deduplicates and tracks alerts across runs using each result's
**`fingerprints`**. FairUX emits one entry per result under the versioned key **`fairuxV1`**
(e.g. `"fingerprints": { "fairuxV1": "a1b2c3d4e5f60718" }`). Two practical consequences:

- **Stable across edits.** The fingerprint is built from the rule id, category, a short
  normalized text hint, the primary locator, and the rule's major version — *not* from the full
  surrounding text or the severity. So small copy edits or a severity override do **not** create a
  "new" alert; GitHub keeps the existing one. This is what makes "fix it once, it stays fixed"
  work.
- **Portable across runtimes.** The same fingerprint is produced whether the finding came from
  the static-HTML adapter (CI) or, later, the live-DOM adapter. A baseline built in CI transfers
  to a browser-extension scan of the same page.

### Limits — read these before relying on baselines

1. **Source line vs. selector.** When FairUX has a source location (static HTML), the SARIF result
   carries a `physicalLocation` (file + line). When it doesn't (DOM/Figma runtimes, by design),
   it carries a `logicalLocation` (a CSS selector / path). GitHub's line-drift tracking only
   applies to physical locations; selector-based results re-anchor on the locator instead. Mixing
   runtimes for the *same* page is fine (fingerprints match), but don't expect line-level drift
   tracking on DOM-originated results.

2. **Locator churn moves the fingerprint.** The primary locator is part of the fingerprint. If a
   finding's element loses its stable `id` and falls back to an `:nth-child(...)` path, restructuring
   the surrounding markup can change that path — and therefore the fingerprint — producing a
   "new" alert for what is arguably the same issue. Prefer stable `id`s on elements you expect
   FairUX to flag repeatedly.

3. **`fairuxV1` is versioned on purpose.** If the fingerprint algorithm ever changes, FairUX will
   emit both `fairuxV1` and `fairuxV2` for a transition window so your existing baselines don't
   silently invalidate. Pin your expectations to the key, not to the raw value.

4. **No suppression model yet.** FairUX does not emit SARIF `suppressions`. To silence a rule,
   disable it in `fairux.config.ts` (`rules[id]: false`); the finding then never appears in the
   SARIF at all (so GitHub closes the alert as "no longer reported").

## Promoting to blocking

Once the team trusts the signal, make high-severity findings block merges. Two options:

- **Branch protection on code scanning**: require the FairUX code-scanning check to pass, and set
  the alert threshold so `error`-level (i.e. FairUX `high`) results block. This keeps `medium`/`low`
  advisory while gating on `high`.
- **Fail the job directly**: drop `continue-on-error` and have the build fail when FairUX reports
  `high` findings. (FairUX's exit-code-by-severity is not implemented yet — track this as a future
  enhancement; until then, gate via code scanning's severity threshold above.)

Start advisory, gate on `high` only, widen later. A linter that blocks too early gets uninstalled.
