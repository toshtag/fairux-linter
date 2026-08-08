# Compatibility and deprecation

What may change, what may not, and what happens first when something has to go.

> Everything here describes a **`0.x`**. Both packages are published on `latest`, which means a plain
> `npm install` resolves them and that they do what these documents say — it does **not** mean the
> surface is frozen. Under SemVer a `0.x` minor may break, and this project uses that: the guarantees
> below are what `1.0` will be held to; before `1.0` they are commitments rather than guarantees.

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

Two rows are worth a sentence each. **Refusing a flag combination** covers arguments the CLI once
accepted and ignored; each now exits 2, which is breaking for a script that passed one.
**`--fix-write`** exits 0 rather than 1 when two rules ask for the identical edit — same file, same
scan-time checksum, same range, same expected text, same replacement — and stderr names which
remediation was applied. Any other conflict still exits 1, including two rules that want the same
range and disagree about what belongs there. A run that stops failing is not a break, so that one is
not in the table.

A `css` locator's *value* may now be a sequence separated by ` >>> `, so a live-DOM finding inside an
open shadow root can be resolved one root at a time. Every value an old consumer could already
receive is still exactly what it was — a document with no shadow root produces the same flat selector
— so `schemaVersion` does not move. A consumer meeting the new form and passing the whole string to
`querySelector` gets a thrown `SyntaxError` rather than a wrong element, which is the deliberate part;
see [the report schema](report-schema.md#nodelocator).

### `schemaVersion` and why it has not moved

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
| Every entry point `exports` declares is built, types and all | `pnpm check:build-output` |
| A consumer example imports nothing internal | `tests/unit/external-consumer-boundary.test.ts` |
| Everything else here | review |

The last row is deliberate: a policy claiming to be fully mechanised would be less honest than one
that says which half is.

## Related

- [API inventory](../generated/sdk-api-inventory.md) — the surface, as committed
- [Report schema](report-schema.md) — the envelope and its versioning rules
- [Roadmap](../roadmap.md) — where the project is, and what it deliberately does not do
