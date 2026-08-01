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
      - uses: pnpm/action-setup@v5
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
- Severity maps **`high → error`, `medium → warning`, `low`/`info` → `note`**. Uploading an
  `error` result does not block a pull request on its own — see *Promoting to blocking* below. To
  re-grade a rule for your team, use `fairux.config.ts` (`rules[id].severity`) — **not** the
  workflow — so the JSON and SARIF outputs stay in sync.

## What the SARIF says about coverage

`run.properties.fairux.coverage` carries the same coverage block as the JSON report: the capabilities
that input supplied, and every rule as executed or skipped with a reason. It is property-bag data — a
consumer that does not know the field ignores it, and GitHub does.

It is deliberately **not** a `toolExecutionNotifications` entry. GitHub surfaces notifications, and a
rule skipped because a Figma export has no source lines is not something to raise on every pull
request. `executionSuccessful` stays `true` for the same reason: a skipped rule is a fact about the
input, not a failure of the run.

Nothing about results, locations, levels, or fingerprints changes with it. The practical use is the
one an alert list cannot serve: **a code scanning run with zero alerts is not the same as a run that
checked everything**, and the SARIF file records which of the two it was. See
[the report schema](./fairux-report-schema.md#coverage).

## Fingerprints and baselines

SARIF provides two separate properties that matter here.

- **`fingerprints.fairuxV1`** is FairUX-owned. It is built from the rule id, category, a short
  normalized text hint, the primary locator, and the rule's major version — _not_ from the full
  surrounding text or the severity — and it carries the same value whether the finding came from the
  static-HTML adapter or the live-DOM adapter. It is for FairUX-aware and generic SARIF consumers
  building their own matching. GitHub code scanning does not use this key for its native alert
  matching.
- **`partialFingerprints`** is a SARIF-standard property, not a GitHub-owned namespace. GitHub code
  scanning currently uses the `primaryLocationLineHash` entry from it.

**FairUX emits no `partialFingerprints`.** The reporter has locations but not the source-file
contents required to compute GitHub's source-aware `primaryLocationLineHash`.

Measured consequence: an alert **kept its identity across a line move**. The same finding, moved
three lines by a real commit, stayed the same alert and stayed open, and a finding that stopped
being reported became `fixed` rather than disappearing. The *mechanism* was not observed — the
alerts API returned no `partial_fingerprints` on any read, which is not the same as GitHub having
generated none. See [SARIF upload canary](./sarif-upload-canary.md).

### What the upload Action does with the gap

When a SARIF file without fingerprint data is uploaded through
`github/codeql-action/upload-sarif`, the Action attempts to populate
`partialFingerprints.primaryLocationLineHash` from the checked-out source files.

That attempt requires a primary physical location with a usable artifact URI and line number, and
the URI must resolve to an existing, non-directory path under the Action's source root. The field
can remain absent when those conditions are not met.

What follows:

- GitHub-native matching can benefit from the Action-side fingerprint only when the Action
  successfully resolves and fingerprints the primary source location. A physical location by itself
  is not a generation guarantee.
- FairUX HTML and JSX/TSX scans normally provide physical locations, but the source file must still
  exist at upload time and resolve relative to the checkout/source root.
- `fairuxV1` remains available to consumers that explicitly understand it. GitHub does not read it.
- **No test in this repository proves GitHub deduplication across HTML and live-DOM reports.** Do
  not plan around it.
- **A result with no physical location fails the whole upload.** Code scanning answers
  `locationFromSarifResult: expected a physical location` and rejects the entire submission, not the
  one result — so a single Figma or DOM finding used to mean nothing was uploaded, including the
  source-located findings beside it. A result with no `locations` at all is rejected the same way.
  Measured; the record is in [SARIF upload canary](./sarif-upload-canary.md).
- FairUX therefore anchors a locator-only finding to the **file that was scanned**, with no
  `region`, and keeps the logical location in the same SARIF location. GitHub displays such a result
  at line 1. A scan with no file at all — a live DOM — has nothing true to name, so it stays
  logical-only and cannot be uploaded. This guide makes no claim about how code scanning *tracks* a
  file-anchored result across changes.

### Limits — read these before relying on baselines

1. **Direct REST API uploads do not receive the Action-side fingerprint population.** If you POST
   SARIF straight to the code-scanning REST API, `github/codeql-action/upload-sarif` does not run
   and therefore cannot add `partialFingerprints.primaryLocationLineHash`. FairUX provides no
   substitute for that path. GitHub documents that results are still processed and displayed, but
   duplicate alerts may occur when fingerprint data is absent; calculate and include suitable
   `partialFingerprints` before a direct API upload when stable GitHub alert matching is required.

2. **A valid physical location is not always a reachable one.** A result can carry a well-formed
   physical SARIF location while the referenced file is unavailable to the upload Action — for
   example, when the file was deleted or moved after the scan, the URI resolves outside the Action's
   source root, or the URI does not resolve to an existing non-directory path. In those cases, no
   Action-generated `primaryLocationLineHash` is guaranteed.

   A generated build artifact does not need to be committed merely for fingerprinting. It can be
   used when it still exists under the source root at upload time and its SARIF URI resolves to it.

3. **Locator churn moves `fairuxV1`.** The primary locator is part of the FairUX fingerprint. If a
   finding's element loses its stable `id` and falls back to an `:nth-child(...)` path, restructuring
   the surrounding markup can change that path — and therefore the fingerprint — producing a "new"
   finding for what is arguably the same issue. Prefer stable `id`s on elements you expect FairUX to
   flag repeatedly.

4. **`fairuxV1` is versioned on purpose.** If the fingerprint algorithm ever changes, FairUX will
   emit both `fairuxV1` and `fairuxV2` for a transition window so your existing matching doesn't
   silently invalidate. Pin your expectations to the key, not to the raw value.

5. **No suppression model yet.** FairUX does not emit SARIF `suppressions`. To silence a rule,
   disable it in `fairux.config.ts` (`rules[id]: false`); the finding then never appears in the
   SARIF at all (so GitHub closes the alert as "no longer reported").

## Promoting to blocking

Once the team trusts the signal, make high-severity findings block merges. Two options:

- **Code scanning merge protection**: add a ruleset that requires the FairUX code-scanning check,
  with the alert threshold set so `error`-level (i.e. FairUX `high`) results block. This keeps
  `medium`/`low` advisory while gating on `high`. Uploading an `error` result does nothing on its
  own — this configuration is what makes it block.
- **Fail the job directly**: use `fairux scan <path> --fail-on high` to exit with code 1 when
  any `high`-severity finding is reported. Set `--fail-on medium` to also fail on `medium`, etc.
  Combine with `continue-on-error: true` if you want the SARIF uploaded even on failure.

Start advisory, gate on `high` only, widen later. A linter that blocks too early gets uninstalled.
