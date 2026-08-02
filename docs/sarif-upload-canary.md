# SARIF upload canary

What GitHub code scanning actually does with FairUX SARIF, observed rather than assumed.

Two claims depend on it and neither had ever been checked:

- **`partialFingerprints` generation.** `packages/report/src/sarif.ts` used to emit
  `primaryLocationLineHash` computed as `fnv1a64(file:line:ruleId)`. The line was an input, so the
  fingerprint moved with the line — and because FairUX supplied the field, `upload-sarif` skipped
  generating a correct one. [Issue #78](https://github.com/toshtag/fairux-linter/issues/78) dropped
  the field in [PR #79](https://github.com/toshtag/fairux-linter/pull/79). That GitHub then
  generates its own is the reason dropping it was right.
- **Logical-only results.** DOM and Figma findings carry no source file. FairUX emits
  `logicalLocations` and no `physicalLocation`, which SARIF permits; how code scanning displays or
  deduplicates that is undocumented for this shape.

`fingerprints.fairuxV1` is FairUX-owned and cross-runtime stable. GitHub never reads it, and it is
not a substitute for either observation.

## What this touches

The canary uploads real analyses to this repository's code scanning and then deletes them. A
dedicated ref **separates them from the default branch's analysis set**, which is what the Security
tab shows by default. It does not make them invisible, and nothing here should say otherwise.

Everything the canary is allowed to touch is a pure function in
`scripts/sarif-canary-contract.mjs`, checked by `tests/unit/sarif-canary-contract.test.ts` with no
network call. That placement is deliberate: an upload aimed at the wrong ref and a delete aimed at
the wrong analysis are both irreversible by rerunning, and neither would be caught by a green canary
run — the run that did the damage would report success.

| Boundary | Rule |
| --- | --- |
| Ref | exactly `refs/heads/fairux-sarif-canary-<main-short-sha>`, and never the repository's default branch, read at run time |
| Commits | full 40-character SHAs; an abbreviation or a ref name is refused |
| Tool | `FairUX` |
| Categories | four, one per probe, matched exhaustively — never by prefix. GitHub reported `category: ""` for all of them; see the observation record |
| Deletion | keyed on the ref, which is unique per run; refused outright if the listing holds an analysis carrying a category this canary does not own |
| Trigger | `workflow_dispatch` only |
| Token | `contents: read` and `security-events: write`; no `contents: write`, no OIDC, no secret |

The branch and its commits are created by the owner outside the workflow. That is why the workflow
needs no write access to the repository at all.

## Running it

### 1. Create the canary branch

Two commits: the fixture as it is on `main`, then the same fixture with only the target line moved.

```bash
git switch main
git pull --ff-only origin main
SHORT=$(git rev-parse --short HEAD)
git switch -c "fairux-sarif-canary-$SHORT"
git push -u origin "fairux-sarif-canary-$SHORT"
git rev-parse HEAD   # sha_before
```

Then move the finding down by inserting lines above it in
`tests/fixtures/sarif-canary/page.html` — nothing else — commit, push, and record `sha_after`.
The finding must stay exactly one, at a different line. Verify before pushing:

```bash
pnpm build
node apps/cli/dist/index.js scan tests/fixtures/sarif-canary/page.html \
  --format json --ignore-config
```

### 2. Observe

```bash
gh workflow run sarif-upload-canary.yml --ref main \
  -f canary_ref="refs/heads/fairux-sarif-canary-$SHORT" \
  -f sha_before=<sha> -f sha_after=<sha> -f mode=observe
```

Four stages, each followed by its own read of the repository's state:

- **A** — upload both fixtures at `sha_before`. One alert with a physical location, one with
  logical locations only.
- **B** — upload the HTML fixture at `sha_after`, where only the line moved. This is the alert
  identity question.
- **C** — upload a zero-result SARIF into the same analysis set. This is the "does it close"
  question.
- **D** — probe the two candidate shapes for a result with no source file: no `locations` at all,
  and a physical location naming the scanned file itself.

`mode: inspect` reads the current state without uploading anything, for the question "what exists
right now" between an observation and its cleanup.

The evidence is a workflow artifact: one JSON file per stage, plus `stage-b-compare.json`, which
states the two answers rather than leaving raw alert lists to be interpreted later.

### 3. Record

Add what the run answered to [what GitHub does with FairUX SARIF](#what-github-does-with-fairux-sarif),
below — what the API returned, not what the upload was supposed to do. The run's own logs and
artifacts hold the raw reads; that section holds what a reader needs to know without opening them.

An absent `primaryLocationLineHash` in the alerts API is **not** evidence that GitHub generated
none — the API may simply not expose it. `stage-b-compare.json` says which of the two it saw, and
the record must keep that distinction.

### 4. Clean up

Cleanup does not rely on deleting the branch, because deleting a branch does not delete its
analyses.

```bash
gh workflow run sarif-upload-canary.yml --ref main \
  -f canary_ref="refs/heads/fairux-sarif-canary-$SHORT" \
  -f sha_before=<sha> -f sha_after=<sha> -f mode=cleanup
```

It lists the analyses for the exact ref and tool, refuses if any of them carries a category this
canary does not own, deletes from the newest backwards — the only order the API permits — and then
re-reads to confirm none is left. Only after that:

```bash
git push origin --delete "fairux-sarif-canary-$SHORT"
```

Finally, confirm `main` is unchanged: its default-branch alert view, its existing analyses, and its
existing categories.

## What GitHub does with FairUX SARIF

Measured over two runs — [v1](https://github.com/toshtag/fairux-linter/actions/runs/30681985131) on
2026-08-01 and [v2](https://github.com/toshtag/fairux-linter/actions/runs/30751789286) on
2026-08-02, each against its own ref and cleaned up afterwards. Nothing in the workflow changed
between them; the reporter did.

**Alert identity survives a line move.** A finding moved from line 12 to line 15 by a real commit
stayed alert #1 and transitioned `open → open`, rather than closing one alert and opening another.
That is what `primaryLocationLineHash` exists to provide, and it works for SARIF supplying no
fingerprints of its own — which is what [#79](https://github.com/toshtag/fairux-linter/pull/79) bet
on when it stopped emitting the field. Observed in both runs.

**The mechanism was not observed.** `most_recent_instance.partial_fingerprints` read `null` on every
alert in both runs. The alerts API may simply not expose it. Absence is **not** evidence that GitHub
generated no fingerprint, and this record must not be read that way.

**A result that stops being reported becomes `fixed`** — not deleted and not `dismissed`, keeping
its number and its last known location.

**A logical-only result cannot be uploaded, and the fix is measured.** In v1 the reporter's own
Figma shape failed the *whole submission* with `locationFromSarifResult: expected a physical
location`, and so did a result with no `locations` key at all. Only a physical location naming the
scanned file is accepted, displayed at line 1. The reporter now emits exactly that — the scanned
file as a physical anchor, no `region`, the logical location kept beside it — and in v2 GitHub
accepted it `complete` and opened an alert at `design.figjson:1`.

That is the difference between the two runs worth stating plainly: [#90](https://github.com/toshtag/fairux-linter/issues/90)
was closed on a shape *derived* from what v1 accepted, and deriving is not uploading. v2 is the
measurement, and it closes [release criterion R4](release-criteria-1.0.md).

**An `automationDetails.id` becomes a category only when it contains a `/`.** v1 sent four distinct
ids without one and every analysis came back `category: ""`, so cleanup's category-keyed matcher
recognised none of its own uploads. It failed safe — cleanup refuses on an unrecognised analysis —
and it did not affect the observations above, which are about sequential transitions one shared
analysis set produces identically. v2 sent the documented trailing slash and all four categories
came back exactly as submitted, with `analysesNotThisCanary: 0` at every read.

Ownership still rests on the ref, which is unique per run. The category is a corroborating check,
and v2 is the first evidence it can actually corroborate.

**A refused submission still leaves an empty analysis under its category.** v2's no-`locations`
probe returned `failed` with `analyses_url: null`, and the next read listed an analysis for that
category with `results_count: 0`. Worth knowing before reading a zero-result analysis as a scan that
found nothing.

**Uploads may not persist for the length of a session.** In v1, GitHub removed all eight analyses
and both alerts on its own within three minutes, with no mechanism observed — nothing in this
repository issued a `DELETE`, and the cleanup run failed on the *listing*, which is how the
disappearance was found. It did not recur in v2, where all six analyses were present at the last
read. **One run each way is not enough to call either the norm.** What carries forward either way is
that a canary must read the state it is about to act on rather than the state it created.

## Both runs are cleaned up

| Run | Cleanup | Result |
| --- | --- | --- |
| v1 | [30682313365](https://github.com/toshtag/fairux-linter/actions/runs/30682313365) | `deleted: []`, `remaining: 0` — GitHub had already removed them |
| v2 | [30751895774](https://github.com/toshtag/fairux-linter/actions/runs/30751895774) | six deleted, newest first, `remaining: 0` |

Both branches are deleted. `main` had no code scanning analysis before either canary and has none
now.
