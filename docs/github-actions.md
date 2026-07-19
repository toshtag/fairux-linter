# Using FairUX in GitHub Actions

FairUX emits **SARIF 2.1.0** (`--format sarif`), which GitHub code scanning understands. This
guide shows how to surface FairUX findings as code-scanning alerts on pull requests.

> FairUX does not provide legal judgments. Findings are UX risk signals for review.

> **Scanning untrusted pull requests? Pass `--ignore-config`.** FairUX never auto-runs executable
> config (auto-discovery only loads `fairux.config.json`), so there's no arbitrary-code-execution
> risk — but a `fairux.config.json` the PR ships can still **disable rules, lower severities, or
> fail the scan**, distorting your results. `--ignore-config` is required (not just defense in
> depth) to keep the checked-out branch from influencing your scan policy. Note this only isolates
> FairUX config: the surrounding workflow (`pnpm install`, `pnpm build`) still runs the PR's own
> lifecycle scripts. See [SECURITY.md](../SECURITY.md#config-files-are-trusted-code).
>
> **Want your team's tuning to apply on untrusted PRs?** `--ignore-config` ignores _all_ config,
> including your own. To apply a trusted policy without trusting the PR, extract your config from the
> **base** branch and pass it explicitly — never auto-discover from the PR checkout:
>
> ```yaml
> - name: Extract trusted FairUX policy from the base branch
>   # A default actions/checkout fetches only the PR's head commit, so the base SHA may not be
>   # present locally — fetch it before `git show`, or use `actions/checkout` with `fetch-depth: 0`.
>   run: |
>     git fetch --no-tags --depth=1 origin "${{ github.event.pull_request.base.sha }}"
>     git show "${{ github.event.pull_request.base.sha }}:fairux.config.json" > "$RUNNER_TEMP/fairux.config.json"
> - name: Run FairUX with the trusted policy
>   run: pnpm fairux scan ./dist/index.html --format sarif --config "$RUNNER_TEMP/fairux.config.json" > fairux.sarif
> ```
>
> An explicit `--config` pointing at a `.json` is data, not code — no execution risk. The tuning
> notes below (re-grade / silence rules via `fairux.config.*`) therefore apply only when config is
> in effect: with a bare `--ignore-config` run, in-repo severity overrides and suppressions do not.

## Start non-blocking

**Introduce FairUX as advisory first.** Uploading SARIF to GitHub code scanning shows findings
as alerts on the PR's _Security_ tab and inline on the diff — it does **not** fail the job. That
is the right way to start: the team sees the signal, builds trust, and tunes the rules before
anything blocks a merge. Promote to blocking later (see the last section).

The job below scans a built site and uploads SARIF. The `fairux scan` step does **not**
use `continue-on-error`: the CLI exits 0 when findings are present (findings are signals, not
errors) and exits non-zero only on actual failures (file not found, parse error, etc.). The
upload step uses `if: always()` so SARIF is uploaded even if the scan step fails — but a failed
scan typically produces no SARIF file, so the upload will error in that case. If you want to
keep the job green even on scan failures, wrap the scan in a separate step with
`continue-on-error: true` and check the output manually.

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
          node-version: 22.18.0
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm build

      # Scan a static HTML artifact and write SARIF.
      # The CLI exits 0 when findings are present (findings are signals, not errors).
      # It exits non-zero only on real failures (file not found, parse error, etc.).
      # --ignore-config: on pull_request, the checked-out branch is untrusted — don't let a
      # fairux.config.json it ships disable rules or lower severities and skew the scan.
      - name: Run FairUX
        run: pnpm fairux scan ./dist/index.html --format sarif --ignore-config > fairux.sarif

      # Always upload, even if the scan step failed (though a failed scan may produce no SARIF).
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
- Scan whatever HTML your build produces. FairUX accepts single files, directories, globs, and
  stdin. Directory/glob scans produce a batch report and SARIF with one run per input, so you can
  upload one SARIF file for a built site instead of scripting one invocation per page.
- Severity maps **`high → error`, `medium → warning`, `low`/`info` → `note`** (see
  [the SARIF mapping note](../design/decisions/P4-T1-sarif-mapping.md)). To re-grade a rule for your team,
  use `fairux.config.ts` (`rules[id].severity`) — **not** the workflow — so the JSON and SARIF
  outputs stay in sync.

## How baselines work (and their limits)

GitHub code scanning deduplicates and tracks alerts across runs using each result's
**`fingerprints`**. GitHub's `upload-sarif` action uses `partialFingerprints.primaryLocationLineHash`
for baseline tracking when present, and generates its own when absent. FairUX emits:

- **`fairuxV1`** under `fingerprints` — a FairUX-consumer fingerprint for cross-runtime
  portability (same value whether the finding came from static-HTML or live-DOM).
- **`primaryLocationLineHash`** under `partialFingerprints` — enables GitHub's native
  line-drift baseline tracking for results with physical locations.

Two practical consequences:

- **Stable across edits.** The fingerprint is built from the rule id, category, a short
  normalized text hint, the primary locator, and the rule's major version — _not_ from the full
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
   runtimes for the _same_ page is fine (fingerprints match), but don't expect line-level drift
   tracking on DOM-originated results.

2. **Locator churn moves the fingerprint.** The primary locator is part of the fingerprint. If a
   finding's element loses its stable `id` and falls back to an `:nth-child(...)` path, restructuring
   the surrounding markup can change that path — and therefore the fingerprint — producing a
   "new" alert for what is arguably the same issue. Prefer stable `id`s on elements you expect
   FairUX to flag repeatedly.

3. **`fairuxV1` is versioned on purpose.** If the fingerprint algorithm ever changes, FairUX will
   emit both `fairuxV1` and `fairuxV2` for a transition window so your existing baselines don't
   silently invalidate. Pin your expectations to the key, not to the raw value. Note that
   `fairuxV1` is a FairUX-consumer fingerprint — GitHub code scanning uses
   `partialFingerprints.primaryLocationLineHash` for its own dedup/baseline tracking.

4. **No suppression model yet.** FairUX does not emit SARIF `suppressions`. To silence a rule,
   disable it in `fairux.config.ts` (`rules[id]: false`); the finding then never appears in the
   SARIF at all (so GitHub closes the alert as "no longer reported").

## Promoting to blocking

Once the team trusts the signal, make high-severity findings block merges. Two options:

- **Branch protection on code scanning**: require the FairUX code-scanning check to pass, and set
  the alert threshold so `error`-level (i.e. FairUX `high`) results block. This keeps `medium`/`low`
  advisory while gating on `high`.
- **Fail the job directly**: use `fairux scan <path> --fail-on high` to exit with code 1 when
  any `high`-severity finding is reported. Set `--fail-on medium` to also fail on `medium`, etc.
  Combine with `continue-on-error: true` if you want the SARIF uploaded even on failure.

Start advisory, gate on `high` only, widen later. A linter that blocks too early gets uninstalled.
