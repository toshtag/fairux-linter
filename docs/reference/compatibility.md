# Compatibility and deprecation

What may change, what may not, and what happens first when something has to go.

FairUX has behaved as though it had this policy since v0 — `FairUxReport` has only ever gained
fields and `schemaVersion` has never moved. None of that was written where a consumer could read it.
This is that page.

> Everything here describes a **`0.x`**. Both packages are published on `latest`, which means a plain
> `npm install` resolves them and that they do what these documents say — it does **not** mean the
> surface is frozen. Under SemVer a `0.x` minor may break, and this project uses that: the guarantees
> below are what `1.0` will be held to, and before `1.0` they are commitments this project intends to
> keep and has, not a contract anybody has signed.

That paragraph used to say:

> Everything here describes a **beta**. `@fairux/sdk` is on the `next` dist-tag and the `fairux` CLI
> is unpublished.

It survived two CLI releases and then the first stable release of both packages — a page whose whole
subject is what a consumer may rely on, telling them the thing they had just installed did not exist.
Nothing checked it, which is the actual defect: every other status surface in this repository has a
test. `tests/unit/compatibility-status.test.ts` does now.

## What is public

| Surface | Contract |
| --- | --- |
| `@fairux/sdk`, `@fairux/sdk/html`, `@fairux/sdk/dom` | Every export, listed in [the API inventory](../generated/sdk-api-inventory.md) |
| `FairUxReport`, `FairUxBatchReport`, `JourneyReport` | [The report schema](report-schema.md), `schemaVersion` |
| `RiskIndexReport` | Its own `schemaVersion`, independent of the report's |
| SARIF output | SARIF 2.1.0, plus `run.properties.fairux` |
| `fairux` CLI flags and exit codes | The CLI's own surface |

**Not public**, and named so nobody has to guess: every other workspace package (`@fairux/core`,
`@fairux/rules`, `@fairux/html`, `@fairux/dom`, `@fairux/ast`, `@fairux/figma`, `@fairux/report`,
`@fairux/config-node`). They are implementation, they move without notice, and importing one is
outside every guarantee on this page. `tests/unit/external-consumer-boundary.test.ts` enforces that
for the examples this repository ships.

## Additive versus breaking

**Additive** — no version of anything moves except the package's own minor:

- A new optional field on a report, a new enum *value*, a new export, a new CLI flag.
- A new rule, or a new capability an adapter supplies.

Consumers must tolerate unknown fields and unknown enum values. A consumer that switches exhaustively
over `Severity` and throws on an unrecognised one has written a breaking change into their own code,
not found one in ours.

**Breaking** — needs the version move named beside it:

| Change | What moves |
| --- | --- |
| Removing or renaming a report field | `schemaVersion` |
| Changing a field's type, or making an optional one required | `schemaVersion` |
| Removing or renaming an SDK export | the package major |
| A value export becoming type-only | the package major |
| Removing a CLI flag, or changing what an exit code means | the package major |
| Refusing a flag *combination* that used to be accepted | the package major |
| Changing what an existing field's value may contain | `schemaVersion`, unless every old value stays valid |
| Changing the fingerprint algorithm | a new versioned key beside the old one — see below |

Two of those rows exist because of changes made during the CLI beta, and they are worth naming
rather than leaving as categories.

`fairux scan` used to accept several flag combinations it then ignored — `--write-baseline` beside
`--suppress`, `--risk-index-model` without `--risk-index`, `--ignore-config` beside `--config`. Each
now exits 2. That is breaking for a script that wrote one, which is why it is in the table and in the
changelog; it landed inside the beta, before `fairux` has a published version to break.

`--fix-write` moved the other way in one case, which is not in the table because a run that stops
failing is not a break. Two rules asking for the *identical* edit — same file, same scan-time
checksum, same range, same expected text, same replacement — used to leave the file correct and exit
1. It exits 0 now, and stderr says which remediation was applied and which was coalesced into it.
Every other refusal still exits 1, including two rules that want the same range and disagree about
what belongs there.

Coalescing is asked **after** a remediation has been judged on its own. It matches a remediation's
edits against edits an earlier one already made, so a remediation carrying two identical edits
matched on one key and was reported as already satisfied — never resolved, never checked, and
counted as accounted for. The self-check runs first, and resolves against the bytes the scan saw
rather than the file as it now stands: that is the only version a remediation makes a claim about,
its `fileChecksum` attests to it, and judging against the current text would make one remediation's
validity depend on what an unrelated earlier one happened to write. A remediation whose own edits
cover the same characters — including two that are identical — is `overlapping-edits`, which is what
that code has always meant.

A `css` locator's *value* may now be a sequence separated by ` >>> `, so a live-DOM finding inside an
open shadow root can be resolved one root at a time. Every value an old consumer could already
receive is still exactly what it was — a document with no shadow root produces the same flat selector
— so `schemaVersion` does not move. A consumer meeting the new form and passing the whole string to
`querySelector` gets a thrown `SyntaxError` rather than a wrong element, which is the deliberate part;
see [the report schema](report-schema.md#nodelocator).

### `schemaVersion` has never moved, and that is the point

It has been `0.1` through every milestone. Coverage, journeys, remediations, the Risk Index, and AI
augmentation were all added under it, because every one of them was a new optional field.

Moving it invalidates every consumer that pinned on it and every stored report. If a change ever
needs to, that is a decision to make deliberately and announce — not something to discover mid-change
while looking for permission.

### Fingerprints are versioned separately

`fairuxV1` is the SARIF key. A change to how a fingerprint is computed emits **both** the old and the
new key for a transition window, so a baseline does not silently stop matching. The report's
`schemaVersion` does not move for it, because the shape did not change — only the value.

## Deprecation

**Nothing is removed without being deprecated first.**

1. The export is marked `@deprecated` in its JSDoc, with what to use instead. That is what a
   consumer's editor shows them, and a deprecation nobody sees is not one.
2. `pnpm api:inventory` records it, so the committed inventory carries `"deprecated": true`.
3. It keeps working, unchanged, for at least one minor release of the package.
4. Removal is a major version, and the inventory check reports whether it was deprecated first —
   `was removed (it was deprecated first)` or `was removed without ever being deprecated`.

Step 4 is why step 2 exists. "Was this deprecated before it was removed?" should be answerable from a
committed artifact, not from anyone's memory of a review.

Un-deprecating is allowed and is reported, so it is a decision rather than the side effect of moving
a comment.

## What is checked, and what rests on review

| Guarantee | How |
| --- | --- |
| No SDK export disappears unnoticed | `pnpm api:inventory:check`, in CI |
| A deprecation is recorded before a removal | the inventory's `deprecated` flag, in the same check |
| Every documented report field exists on the type | `tests/unit/report-schema-contract.test.ts` |
| `schemaVersion` stays `0.1` | the same test |
| The three published entry points stay three | `pnpm check:build-output` |
| A consumer example imports nothing internal | `tests/unit/external-consumer-boundary.test.ts` |
| Everything else here | review |

The last row is not an apology. A policy that claimed to be fully mechanised would be less honest
than one that says which half is.

## Related

- [API inventory](../generated/sdk-api-inventory.md) — the surface, as committed
- [Report schema](report-schema.md) — the envelope and its versioning rules
- [Roadmap](../roadmap.md) — where the project is, and what it deliberately does not do
