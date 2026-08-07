# Release criteria

What has to be true before `@fairux/sdk` and `fairux` leave beta, what has to be true before either
reaches `1.0.0`, what is true now, and what each open item still needs.

> This is a measurement, not a verdict. Several items are blocked on actions this repository cannot
> perform; the list says which, per item, rather than scoring itself passing.
> `tests/unit/release-criteria-contract.test.ts` fails if an item claims to be met without evidence
> beside it.

## Two gates

This document used to describe one, and the one it described was `1.0`. Everything on it was
therefore a blocker for leaving beta, including two criteria that require somebody outside this
repository — so "publish a stable 0.1.0" and "publish 1.0.0" had exactly the same preconditions, and
the beta could never end. That is not a judgement anybody made; it is what a single list does when
its hardest rows are the ones nobody here can close.

| Gate | What it is | What it requires |
| --- | --- | --- |
| **0.x** | `0.1.0` on npm's `latest`: a version this project supports for daily use | Every criterion this repository can verify — product behaviour, the written contracts, platform and supply chain, and the publication itself |
| **1.0** | The compatibility promise, not more features | The 0.x gate, plus long-term API compatibility, plus two criteria that need independent evidence: [P7](#product) and [S6](#platform-and-supply-chain) |

**The 1.0 criteria are not weakened by this split.** `P7` (detection quality on inputs nobody here
tuned against) and `S6` (a third-party security review) are unchanged, still open, and still tracked
as [#280](https://github.com/toshtag/fairux-linter/issues/280) and
[#281](https://github.com/toshtag/fairux-linter/issues/281). What changed is which release they
block. They are the reason `1.0` is not close; they were never the reason a `0.x` should stay a
prerelease, because a `0.x` makes no compatibility promise for them to qualify.

**What a stable `0.x` claims, and what it does not.** It claims the package is published on the
channel a plain `npm install` resolves, that it does what its documents say, and that a break will
be recorded in the changelog. It does **not** claim API stability: `0.x` minors may break, which
[the compatibility document](../reference/compatibility.md) states and `1.0` is the version that
stops.

## Status key

- **met** — done, with a link to the thing that proves it
- **open** — not done, with what it needs
- **n/a** — nothing has triggered it yet, with the trigger named and checked

`n/a` exists because `open` was being used for two different things, and one of them could never
end. A criterion that says "a migration guide exists for anything that broke" cannot be *done* while
nothing has broken; leaving it open reported a gap where there is none, and a permanently open row
teaches a reader to skip the open list. The distinction is only worth anything if the trigger is
machine-checked, so it is: `tests/unit/release-criteria-contract.test.ts` fails if an `n/a` row's
trigger has fired.

## Product

| # | Criterion | Gate | Status | Evidence or what it needs |
| --- | --- | --- | --- | --- |
| P1 | Findings are deterministic for the same input and rule set | 0.x | met | `packages/rules/test/built-in-behavior-contract.test.ts` pins order, ids, counts, and fingerprints |
| P2 | Every built-in rule has a review record, and the record still describes what the rule does | 0.x | met | `pnpm rules:reviews:check`, which compares `rule-review-baseline.json` against the built rules on every run |
| P3 | Detection quality is measured on a corpus this project assembled, not asserted | 0.x | met | [corpus evaluation](../generated/corpus-evaluation.md), checked in CI |
| P4 | Every report says what it was able to check | 0.x | met | [coverage](../reference/report-schema.md#coverage) |
| P5 | No output is presented as a safety, legal, or compliance verdict | 0.x | met | [security boundary](../reference/security-boundary.md), and the disclaimer on every rendered surface |
| P6 | The corpus's known detection gap is closed or accepted in writing | 0.x | met | [#121](https://github.com/toshtag/fairux-linter/issues/121) closed in `obstruction/confirmshaming@1.1.0`; the corpus records no miss |
| P7 | Detection quality is measured on inputs this project has not tuned against | 1.0 | open | Never done, tracked as [#280](https://github.com/toshtag/fairux-linter/issues/280). Needs a holdout meeting the four conditions below. The six third-party fixtures are not one — they were added to the corpus and a rule was fixed against them ([#206](https://github.com/toshtag/fairux-linter/issues/206)), which is what makes them training data |

## Contract

| # | Criterion | Gate | Status | Evidence or what it needs |
| --- | --- | --- | --- | --- |
| C1 | The public surface is inventoried and checked | 0.x | met | [API inventory](../generated/sdk-api-inventory.md), `pnpm api:inventory:check` |
| C2 | Compatibility guarantees are written, and say what a `0.x` does not promise | 0.x | met | [compatibility](../reference/compatibility.md) |
| C3 | A deprecation policy exists, and removals can be judged against it | 0.x | met | same document; the inventory records deprecation |
| C4 | `schemaVersion` semantics are documented and unmoved | 0.x | met | [report schema](../reference/report-schema.md#versioning) |
| C5 | A migration guide exists for anything that broke | 0.x | n/a | Nothing has broken: the report `schemaVersion` is still `0.1` and every package is `0.x`. `release-criteria-contract` fails this row if either moves while it still reads `n/a` |
| C6 | The public surface will not change incompatibly without a major version and a deprecation first | 1.0 | open | Never promised, and a `0.x` deliberately does not: [compatibility](../reference/compatibility.md) says a `0.x` minor may break. Needs that document to state the major-version guarantee, and needs the API inventory to have held across a release cycle rather than only within one |

### What `P7` requires, so it cannot be closed by a smaller thing

A number from pages nobody here wrote is not automatically evidence. Four conditions, written down
before there is a number to argue about:

1. **Per-rule minimums, positive and negative.** A holdout with no page a rule should fire on
   measures nothing about that rule, and a holdout with no page it should *stay quiet* on measures
   nothing about its false-positive rate — which is the number that decides whether anyone keeps the
   tool switched on. Both minimums are per rule, not per corpus; an aggregate hides a rule with zero
   of either.
2. **Stratified by locale and by runtime.** English and Japanese, because those are the dictionaries
   that ship and a third locale would measure their absence. HTML, JSX/TSX, and Figma, because they
   are different adapters with different capabilities and a rule that works on one says nothing
   about the others. Reported per stratum, not pooled: a pooled score hides a stratum that is
   entirely wrong.
3. **Immutable once evaluated.** The pages, the labels, and the rule-pack version are frozen at the
   moment of scoring. A holdout that gets edited after a disappointing result is a corpus, and one
   that contributes a rule fix has become training data — which is exactly what happened to the six
   third-party fixtures, and is not a criticism of them: it is what they were for.
4. **Uncertainty reported with the number.** An interval, and the count it rests on. "Precision
   0.82" from 40 labelled positives is a different claim from the same number over 400, and the
   version without an interval is the one that gets quoted.

None of this makes a first score good. It makes a first score mean something — and a holdout score
lower than the corpus score is the expected outcome, because one of those two numbers is partly a
measurement of who wrote the pages.

## Platform and supply chain

| # | Criterion | Gate | Status | Evidence or what it needs |
| --- | --- | --- | --- | --- |
| S1 | Supported platforms are documented and tested | 0.x | met | [supported platforms](../reference/platforms.md), asserted against `engines` and every CI matrix |
| S2 | The security boundary is explicit | 0.x | met | [security boundary](../reference/security-boundary.md) |
| S3 | Build output is deterministic and release-safe | 0.x | met | `pnpm check:build-output`, plus a double build compared by digest in CI |
| S4 | Publication uses Trusted Publishing with provenance, verified after the fact | 0.x | met | [SDK release runbook](release-sdk.md) |
| S5 | Registry canaries run on a schedule, for every channel this project publishes to | 0.x | met | `registry-consumer-smoke.yml`, `registry-cli-smoke.yml`, both over `next` and `latest`. This row is coverage; the green result is `R6`. The `latest` cells refuse a placeholder rather than installing one, which is what kept them red until `0.1.0` moved that channel |
| S6 | A third-party security review | 1.0 | open | Never had one, tracked as [#281](https://github.com/toshtag/fairux-linter/issues/281). Needs somebody outside this repository |

## Publication

| # | Criterion | Gate | Status | Evidence or what it needs |
| --- | --- | --- | --- | --- |
| R1 | `@fairux/sdk` is published with provenance | 0.x | met | `0.1.0-beta.4` on `next`, provenance attestation verified against a registry install |
| R2 | `fairux` is published | 0.x | met | `0.1.0-beta.2` on `next`, published by `publish-cli.yml` through Trusted Publishing; provenance verified by `npm audit signatures` |
| R3 | The registry-installed CLI smoke has run green | 0.x | met | `registry-cli-smoke.yml` on `main`, all four cells — Linux and Windows on both Node floors — green against `0.1.0-beta.2` in one dispatch, [run 31134762665](https://github.com/toshtag/fairux-linter/actions/runs/31134762665); the earlier per-cell record from during a GitHub Actions incident is kept in [the CLI runbook](release-cli.md) |
| R4 | The SARIF upload canary has been re-run against the fixed locator shape | 0.x | met | [canary record](sarif-canary.md), 2026-08-02: the shape [#90](https://github.com/toshtag/fairux-linter/issues/90) landed uploads `complete` and opens an alert, where v1's failed the whole submission |
| R5 | Both packages are published as stable releases on `latest` | 0.x | met | `@fairux/sdk@0.1.0` ([run 31141332761](https://github.com/toshtag/fairux-linter/actions/runs/31141332761)) then `fairux@0.1.0` ([run 31145894724](https://github.com/toshtag/fairux-linter/actions/runs/31145894724)), in that order, each moving `latest` off `0.0.0-bootstrap.0` and leaving `next` and `bootstrap` where they were — compared against a pre-publish snapshot, not inferred from current values. Records in the [SDK](release-sdk.md#closeout-evidence--010) and [CLI](release-cli.md#what-the-stable-release-recorded) runbooks |
| R6 | The registry-installed smokes have run green against `latest` | 0.x | met | `registry-consumer-smoke.yml` [31145915924](https://github.com/toshtag/fairux-linter/actions/runs/31145915924), four cells; `registry-cli-smoke.yml` [31146168212](https://github.com/toshtag/fairux-linter/actions/runs/31146168212), eight cells — Linux and Windows on both Node floors, over `next` and `latest`. The `latest` cells had been red since they were added, because they refuse the placeholder rather than installing it |

## The 0.x stable gate is met

Every row above reads `met` or `n/a`. `R5` and `R6` were the last two, and both closed the way this
repository requires: a measurement read back from an external source after the fact, not a run that
was attempted.

What that does **not** mean is written in the row it belongs to and repeated here because a met gate
is the sentence most likely to be over-read: a stable `0.x` says the packages are what a plain
`npm install` resolves and do what these documents say. It says nothing about API stability, and
nothing about the rule set being complete or the Risk Index being right.

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

`P3` used to read "detection quality is measured, not asserted", and its evidence was the corpus
evaluation. The measurement is real and the sentence was wider than it: 51 of the corpus's 57 pages
were written by whoever also wrote the rules, and the other six stopped being independent the moment
a rule was fixed against them. What that row can honestly claim is quality *on this corpus*, which
is what it now says, and the claim it was standing in for is `P7` — measured on inputs nobody here
tuned against, which has never happened. Splitting them turns one criterion that was met into one
that is met and one that is open, which is the point: a single row cannot be half true.

`P2` used to read "maintainer-approved review record". For one release that meant a protected GitHub
environment and a human clicking Approve, and the criterion could be evaluated by looking for the
approval event. That machinery was removed — a rule change has no publish, no deployment and no secret
behind it — so the criterion now says what CI can actually check. A criterion nobody can evaluate is
worse than an open one.

`C5` used to be open, and would have stayed open forever: it asks for a migration guide for anything
that broke, and nothing has broken. A row that cannot be closed by any amount of work is not a gap,
and reporting it as one trains a reader to skip the open list — which is where the rows that *are*
gaps live. It is `n/a` now, with the trigger named and checked rather than promised: the contract
test fails this row the moment `schemaVersion` leaves `0.1` or a package reaches `1.0.0`.

## Open items, gathered

**0.x stable gate:** none. Its last two rows are met, and the section above says which.

**1.0 gate:** `P7`, `S6`, and `C6`, and they do not all need the same thing.

| | Needs | Tracked as |
| --- | --- | --- |
| `P7` | **somebody outside this repository** — pages nobody here wrote and has not tuned against | [#280](https://github.com/toshtag/fairux-linter/issues/280), `external-evidence` |
| `S6` | **somebody outside this repository** — a security review by someone who did not build this | [#281](https://github.com/toshtag/fairux-linter/issues/281), `external-evidence` |
| `C6` | work in this repository: the compatibility document stating the major-version guarantee, and the API inventory holding across a release cycle | no issue; it is a decision this project has not made yet |

`P7` and `S6` carry the `external-evidence` label, which is what that label is for: an issue nobody
can close by working here. Neither is closed, and a stable `0.1.0` does not make either smaller.

`C6` carries no such label, and should not. A `0.x` is where this project says it may still break
things, so the promise is one it has deliberately withheld rather than one it is waiting on — and
withholding a promise is a decision, which is a thing that can be made here.

The migration-guide row is **not** in either list. It is `n/a`, not open — nothing has broken, and
the criteria test fails it if that stops being true.

**Two of the three 1.0 criteria cannot be closed from inside this repository**, and that was true of
the two publication criteria too until somebody outside it acted. The third, `C6`, is this
project's own decision to make — which is why `1.0` is not close, and not the same as `1.0` being
blocked.
