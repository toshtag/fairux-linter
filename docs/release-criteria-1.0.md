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
| P2 | Every built-in rule has a maintainer-approved review record | met | [P13 review packet](reviews/P13-built-in-rule-maintainer-review.md), with the current state re-verified by `pnpm rules:reviews:check` |
| P3 | Detection quality is measured, not asserted | met | [corpus evaluation](generated/corpus-evaluation.md), checked in CI |
| P4 | Every report says what it was able to check | met | [coverage](fairux-report-schema.md#coverage) |
| P5 | No output is presented as a safety, legal, or compliance verdict | met | [security boundary](security-boundary.md), and the disclaimer on every rendered surface |
| P6 | The corpus's known detection gap is closed or accepted in writing | met | [#121](https://github.com/toshtag/fairux-linter/issues/121) closed in `obstruction/confirmshaming@1.1.0`; the corpus records no miss |

## Contract

| # | Criterion | Status | Evidence or what it needs |
| --- | --- | --- | --- |
| C1 | The public surface is inventoried and checked | met | [API inventory](generated/sdk-api-inventory.md), `pnpm api:inventory:check` |
| C2 | Compatibility guarantees are written | met | [compatibility](compatibility.md) |
| C3 | A deprecation policy exists, and removals can be judged against it | met | same document; the inventory records deprecation |
| C4 | `schemaVersion` semantics are documented and unmoved | met | [report schema](fairux-report-schema.md#versioning) |
| C5 | A migration guide exists for anything that broke | open | Nothing has broken. This becomes required the first time `schemaVersion` or a package major moves, and is empty until then |

## Platform and supply chain

| # | Criterion | Status | Evidence or what it needs |
| --- | --- | --- | --- |
| S1 | Supported platforms are documented and tested | met | [supported platforms](supported-platforms.md), asserted against `engines` and every CI matrix |
| S2 | The security boundary is explicit | met | [security boundary](security-boundary.md) |
| S3 | Build output is deterministic and release-safe | met | `pnpm check:build-output`, plus a double build compared by digest in CI |
| S4 | Publication uses Trusted Publishing with provenance, verified after the fact | met | [SDK beta release runbook](sdk-beta-release.md) |
| S5 | Registry canaries run on a schedule | met | `registry-consumer-smoke.yml`, `registry-cli-smoke.yml` |
| S6 | A third-party security review | open | Never had one. Needs somebody outside this repository |

## Publication

| # | Criterion | Status | Evidence or what it needs |
| --- | --- | --- | --- |
| R1 | `@fairux/sdk` is published with provenance | met | `0.1.0-beta.3` on `next` |
| R2 | `fairux` is published | open | Blocked since M1 on two owner actions on npmjs.com: creating the package name, and configuring its Trusted Publisher record. See the [CLI beta release runbook](cli-beta-release.md) |
| R3 | The registry-installed CLI smoke has run green | open | Cannot run until R2. It fails accurately today: `fairux@next is absent on the public registry` |
| R4 | The SARIF upload canary has been re-run against the fixed locator shape | open | [#90](https://github.com/toshtag/fairux-linter/issues/90) is fixed in the repository and unmeasured since. Needs one dispatch of `sarif-upload-canary.yml` and the result recorded in the [canary record](sarif-upload-canary.md) |

## What "1.0" would mean

That the report envelope, the SDK surface, and the CLI's flags are ones this project will not break
without a major version and a deprecation first — and that the things it declines to do are
declining, not pending.

It would **not** mean that the rule set is complete, that the Risk Index model is right, or that a
clean scan is a safe product. Those are stated in each output and would still be stated in 1.0.

`P6` was open until `obstruction/confirmshaming@1.1.0`. It closed the way this repository says a rule
change has to: a version bump, an updated review record, and a fresh maintainer approval — not by
editing the label that recorded the miss.

## Open items, gathered

`C5`, `S6`, `R2`, `R3`, `R4`. Two of them (`R2`, `R3`) are one owner action apart, one (`C5`) is
empty by construction until something breaks, one (`R4`) is a single workflow dispatch, and one
(`S6`) needs somebody outside this repository.
