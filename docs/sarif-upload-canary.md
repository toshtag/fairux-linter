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

Record what the API returned, not what the upload was supposed to do.

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

## Observation record

### v1 — 2026-08-01

Ref `refs/heads/fairux-sarif-canary-a9dc68c`, tool `FairUX`, on
[run 30681985131](https://github.com/toshtag/fairux-linter/actions/runs/30681985131), read back by
[run 30682062072](https://github.com/toshtag/fairux-linter/actions/runs/30682062072). Commits
`a9dc68c9…` (finding at line 12) and `55f71724…` (same finding, line 15 — three paragraphs inserted
above it and nothing else).

| Stage | Uploaded | `processing_status` | Result |
| --- | --- | --- | --- |
| A | HTML fixture, physical location | `complete` | alert **#1**, `open`, `page.html:12`, level `warning` |
| A | Figma fixture, as the reporter emits it | **`failed`** | `locationFromSarifResult: expected a physical location` |
| B | HTML fixture at the moved line | `complete` | alert **#1**, `open`, `page.html:15` — same alert number |
| C | zero results, same ref and tool | `complete` | alert **#1** → `fixed` |
| D | Figma finding with no `locations` key | **`failed`** | `locationFromSarifResult: expected at least one location` |
| D | Figma finding located at the scanned file, no region | `complete` | alert **#2**, `open`, `design.figjson:1` |

**Alert identity survives a line move.** The finding moved from line 12 to line 15 in a real commit
and stayed alert #1, transitioning `open → open` rather than closing one alert and opening another.
That is the behaviour `primaryLocationLineHash` exists to provide, and it works for FairUX SARIF
that supplies no fingerprints of its own — which is what
[#79](https://github.com/toshtag/fairux-linter/pull/79) was betting on.

**The mechanism was not observed.** `most_recent_instance.partial_fingerprints` came back `null` on
every read. The alerts API may simply not expose it. Absence here is **not** evidence that GitHub
generated no fingerprint, and the record must not be read that way.

**A result stops being reported → the alert is `fixed`.** Not deleted, not `dismissed`: `fixed`,
keeping its number and its last known location.

**Logical-only results cannot be uploaded at all.** Both the reporter's own shape and the
no-`locations` alternative fail the *whole submission*, not the one result. Only a physical location
naming the scanned file is accepted, and GitHub displays it at line 1. That observation turned
[#90](https://github.com/toshtag/fairux-linter/issues/90)'s three unknowns into one decided option,
and the reporter now emits it: a locator-only finding carries the scanned file as its physical
anchor, with no `region`, alongside the logical location it always carried.

**The fixed shape has not been re-measured.** It follows from what stage D accepted, which is not
the same as having been uploaded. Re-running the canary against it is the next run's first job.

**The categories did not take effect.** All four submissions carried distinct
`automationDetails.id` values and every resulting analysis came back with `category: ""`: an id with
no `/` in it does not become a category. So the four analysis sets the design assumed were one set,
and cleanup's category-keyed matcher recognised none of its own uploads — zero canary analyses,
eight foreign.

It failed safe, and it does not invalidate anything above. The stages were sequential and each
observation is about the transition it caused, which one shared set produces identically: A created
alert #1, B moved it, C closed it, D created alert #2 while #1 stayed `fixed`. What it does
invalidate is the claim that categories separated them. Ownership now rests on the ref, which is
unique per run and refused for anything else; the id carries the documented trailing slash, and
whether *that* produces a non-empty category is **not measured** and is the next canary's question.

**GitHub removed the analyses and the alerts on its own, and why is not known.** The timeline, from
the run logs:

| Time (UTC) | Read | Analyses | Alerts |
| --- | --- | --- | --- |
| 03:29 | [30682062072](https://github.com/toshtag/fairux-linter/actions/runs/30682062072) | 8 | #1 `fixed`, #2 `open` |
| 03:32 | [30682186613](https://github.com/toshtag/fairux-linter/actions/runs/30682186613) | `404 no analysis found` | — |
| 03:34 | [30682273296](https://github.com/toshtag/fairux-linter/actions/runs/30682273296) | 0 | 0 |

Nothing in this repository deleted them. The 03:32 run was `mode: cleanup`, and it failed on the
*listing* — before it could issue a single `DELETE` — which is also how the 404 was found. The
branch still existed at every one of those reads and was deleted afterwards, by hand, once the state
was confirmed empty.

No mechanism is recorded here, because none was observed. What is worth carrying forward is that a
canary cannot assume its own uploads persist for the length of a session: a future run has to read
the state it is about to act on rather than the state it created.

#### Cleanup

[Run 30682313365](https://github.com/toshtag/fairux-linter/actions/runs/30682313365):
`{"deleted": [], "remaining": 0}` — nothing left to delete, and the confirmation pass agreed. The
branch `fairux-sarif-canary-a9dc68c` was then deleted from the remote. `main` never had a code
scanning analysis before this canary and has none now; the repository reported
`no analysis found` for the whole repository before the first upload.

### v2 — 2026-08-02

Ref `refs/heads/fairux-sarif-canary-0a505cc`, tool `FairUX`, on
[run 30751789286](https://github.com/toshtag/fairux-linter/actions/runs/30751789286). Commits
`0a505ccd…` (finding at line 12) and `aacbf80d…` (same finding, line 15 — three paragraphs inserted
above it and nothing else). Nothing in the workflow changed between v1 and v2; the reporter did.

Run to answer the two things v1 left unmeasured, and both answered.

| Stage | Uploaded | `processing_status` | Result |
| --- | --- | --- | --- |
| A | HTML fixture, physical location | `complete` | alert **#1**, `open`, `page.html:12`, level `warning` |
| A | Figma fixture, **as the reporter now emits it** | **`complete`** | alert **#2**, `open`, `design.figjson:1`, level `error` |
| B | HTML fixture at the moved line | `complete` | alert **#1**, `open`, `page.html:15` — same alert number |
| C | zero results, same ref and category | `complete` | alert **#1** → `fixed` |
| D | Figma finding with no `locations` key | **`failed`** | `locationFromSarifResult: expected at least one location` |
| D | Figma finding located at the scanned file, no region | `complete` | accepted; no new alert — same rule and location as stage A's |

**The fixed locator shape uploads.** This is what
[#90](https://github.com/toshtag/fairux-linter/issues/90) was closed on and what
[release criterion R4](release-criteria-1.0.md) was open on. In v1 the reporter's own emitted shape
failed the whole submission with `expected a physical location`; it now carries the scanned file as
a physical anchor with no `region`, and GitHub accepts it, displays it at line 1, and opens an alert
for it. The change was **not** re-measured when it landed, and this is that measurement.

**The trailing slash was the category fix.** v1 recorded `category: ""` on all four analyses and
named this the next canary's question. All four categories now come back exactly as submitted —
`…-physical`, `…-logical`, `…-logical-nolocations`, `…-logical-inputfile` — and
`analysesNotThisCanary` was `0` at every read. So an `automationDetails.id` becomes a category only
when it contains a `/`, which is what GitHub's documentation says and what v1 could not confirm
because it had never sent one.

Ownership still rests on the ref. That does not change: the ref is unique per run and the category
is a corroborating check, and this run is the first evidence that the corroborating check can
actually corroborate.

**A refused submission still leaves an empty analysis under its category.** Stage D's
no-`locations` upload came back `failed` with `analyses_url: null` and `accepted: false`, and the
next read listed an analysis for `…-logical-nolocations` with `results_count: 0`. Cleanup deleted it
with the rest. Worth knowing before reading a zero-result analysis as a scan that found nothing.

**Reproduced from v1, unchanged.** Alert identity survives a line move — #1 went 12 → 15 and stayed
`open` rather than closing and reopening. A result that stops being reported becomes `fixed`, not
deleted and not `dismissed`, keeping its number and its last known location. A result with no
`locations` at all is still refused outright.

**`partialFingerprints` is still `null`** on every alert read. Absence here is not evidence that
GitHub generated no fingerprint; the alerts API may simply not expose it. The line move working is
the behaviour that matters and it is observed directly.

**Nothing disappeared on its own this time.** v1 recorded GitHub removing the analyses and the
alerts within three minutes, with no mechanism observed. All six analyses were still present at the
last read and were deleted by cleanup. One run each way is not enough to call either the norm.

#### Cleanup

[Run 30751895774](https://github.com/toshtag/fairux-linter/actions/runs/30751895774):
`{"deleted": [1560479000, 1560478857, 1560478699, 1560478501, 1560478356, 1560478221], "remaining": 0}`
— six analyses, newest first, and the confirmation pass agreed. The branch
`fairux-sarif-canary-0a505cc` was then deleted from the remote, and the repository reports
`no analysis found` again, which is the state it was in before the run.
