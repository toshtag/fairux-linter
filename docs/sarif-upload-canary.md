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
| Categories | `fairux-sarif-canary-v1-physical` and `fairux-sarif-canary-v1-logical`, matched exhaustively — never by prefix |
| Deletion | refused outright if the listing for the ref holds anything outside those categories |
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

Three stages, each followed by its own read of the repository's state:

- **A** — upload both fixtures at `sha_before`. One alert with a physical location, one with
  logical locations only.
- **B** — upload the HTML fixture at `sha_after`, where only the line moved. This is the alert
  identity question.
- **C** — upload a zero-result SARIF into the same analysis set. This is the "does it close"
  question.

The evidence is a workflow artifact: one JSON file per stage, plus `stage-b-compare.json`, which
states the two answers rather than leaving raw alert lists to be interpreted later.

### 3. Record

Copy the observations into [status](status.md). Record what the API returned, not what the upload
was supposed to do.

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

It lists the analyses for the exact ref and tool, refuses if any of them is outside this canary's
two categories, deletes from the newest backwards — the only order the API permits — and then
re-reads to confirm none is left. Only after that:

```bash
git push origin --delete "fairux-sarif-canary-$SHORT"
```

Finally, confirm `main` is unchanged: its default-branch alert view, its existing analyses, and its
existing categories.

## Observation record

Not yet run. This section is filled in from the workflow artifact after the first observation, and
until then the two claims above stay unproven — see [status](status.md).
