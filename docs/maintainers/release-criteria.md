# 1.0 release criteria

What has to be true before `@fairux/sdk` and `fairux` leave beta, what is true now, and what each
open item still needs.

> This is a measurement, not a verdict. Several items are blocked on actions this repository cannot
> perform; the list says which, per item, rather than scoring itself passing.
> `tests/unit/release-criteria-contract.test.ts` fails if an item claims to be met without evidence
> beside it.

## Status key

- **met** — done, with a link to the thing that proves it
- **open** — not done, with what it needs

## Product

| # | Criterion | Status | Evidence or what it needs |
| --- | --- | --- | --- |
| P1 | Findings are deterministic for the same input and rule set | met | `packages/rules/test/built-in-behavior-contract.test.ts` pins order, ids, counts, and fingerprints |
| P2 | Every built-in rule has a review record, and the record still describes what the rule does | met | `pnpm rules:reviews:check`, which compares `rule-review-baseline.json` against the built rules on every run |
| P3 | Detection quality is measured, not asserted | met | [corpus evaluation](../generated/corpus-evaluation.md), checked in CI |
| P4 | Every report says what it was able to check | met | [coverage](../reference/report-schema.md#coverage) |
| P5 | No output is presented as a safety, legal, or compliance verdict | met | [security boundary](../reference/security-boundary.md), and the disclaimer on every rendered surface |
| P6 | The corpus's known detection gap is closed or accepted in writing | met | [#121](https://github.com/toshtag/fairux-linter/issues/121) closed in `obstruction/confirmshaming@1.1.0`; the corpus records no miss |

## Contract

| # | Criterion | Status | Evidence or what it needs |
| --- | --- | --- | --- |
| C1 | The public surface is inventoried and checked | met | [API inventory](../generated/sdk-api-inventory.md), `pnpm api:inventory:check` |
| C2 | Compatibility guarantees are written | met | [compatibility](../reference/compatibility.md) |
| C3 | A deprecation policy exists, and removals can be judged against it | met | same document; the inventory records deprecation |
| C4 | `schemaVersion` semantics are documented and unmoved | met | [report schema](../reference/report-schema.md#versioning) |
| C5 | A migration guide exists for anything that broke | open | Nothing has broken. This becomes required the first time `schemaVersion` or a package major moves, and is empty until then |

## Platform and supply chain

| # | Criterion | Status | Evidence or what it needs |
| --- | --- | --- | --- |
| S1 | Supported platforms are documented and tested | met | [supported platforms](../reference/platforms.md), asserted against `engines` and every CI matrix |
| S2 | The security boundary is explicit | met | [security boundary](../reference/security-boundary.md) |
| S3 | Build output is deterministic and release-safe | met | `pnpm check:build-output`, plus a double build compared by digest in CI |
| S4 | Publication uses Trusted Publishing with provenance, verified after the fact | met | [SDK beta release runbook](release-sdk.md) |
| S5 | Registry canaries run on a schedule | met | `registry-consumer-smoke.yml`, `registry-cli-smoke.yml` |
| S6 | A third-party security review | open | Never had one. Needs somebody outside this repository |

## Publication

| # | Criterion | Status | Evidence or what it needs |
| --- | --- | --- | --- |
| R1 | `@fairux/sdk` is published with provenance | met | `0.1.0-beta.3` on `next` |
| R2 | `fairux` is published | met | `0.1.0-beta.1` on `next`, published by `publish-cli.yml` through Trusted Publishing; provenance verified by `npm audit signatures` |
| R3 | The registry-installed CLI smoke has run green | met | `registry-cli-smoke.yml` on `main`, all four cells: Linux and Windows on both Node floors |
| R4 | The SARIF upload canary has been re-run against the fixed locator shape | met | [canary record](sarif-canary.md), 2026-08-02: the shape [#90](https://github.com/toshtag/fairux-linter/issues/90) landed uploads `complete` and opens an alert, where v1's failed the whole submission |

## What "1.0" would mean

That the report envelope, the SDK surface, and the CLI's flags are ones this project will not break
without a major version and a deprecation first — and that the things it declines to do are
declining, not pending.

It would **not** mean that the rule set is complete, that the Risk Index model is right, or that a
clean scan is a safe product. Those are stated in each output and would still be stated in 1.0.

`P6` was open until `obstruction/confirmshaming@1.1.0`. It closed the way this repository says a rule
change has to: a version bump, an updated review record, and a regenerated baseline — not by editing
the label that recorded the miss.

The SARIF upload canary was the one criterion this repository could close by itself: a dispatch, an
observation, and a record. Worth naming what leaving it open had cost — the shape
[#90](https://github.com/toshtag/fairux-linter/issues/90) landed was *derived* from what stage D of
the first canary accepted, which is not the same as having been uploaded, and the repository carried
that inference where a measurement belonged.

The two publication criteria closed together when the CLI beta shipped. The npmjs.com owner actions
they waited on — reserving the package name and saving the Trusted Publisher record — were performed
by the owner; nothing in this repository could do either, and nothing in it published the package.
The workflow did, through OIDC. The evidence recorded against them is the run, the registry
read-back, the provenance attestation, and the four green canary cells, rather than the fact that a
release was attempted — a distinction the SDK's own closeout had to learn, having once recorded a
successful publish as a failure.

`P2` used to read "maintainer-approved review record". For one release that meant a protected GitHub
environment and a human clicking Approve, and the criterion could be evaluated by looking for the
approval event. That machinery was removed — a rule change has no publish, no deployment and no secret
behind it — so the criterion now says what CI can actually check. A criterion nobody can evaluate is
worse than an open one.

## Open items, gathered

`C5` and `S6`. One is empty by construction until something breaks, and one needs somebody outside
this repository.

**Nothing still open here can be closed from inside this repository**, and that was true of the two
publication criteria too until somebody outside it acted.
