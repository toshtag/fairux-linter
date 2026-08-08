# Holdout evaluation

How detection quality gets measured on pages nobody here wrote, and what stops that measurement
turning into another corpus.

> This page describes a harness. **No external holdout exists**, and
> [criterion `P7`](release-criteria.md#product) is open until one does. Running the evaluator against
> the fixture in `tests/fixtures/holdout-harness` proves the harness works and says nothing about
> detection quality — the fixture says so about itself, and the evaluator refuses to call it
> evidence.

## Why this is not the corpus

`corpus/` measures the rule set against pages this project assembled. That measurement is real and
it is bounded: most of those pages were written by whoever also wrote the rules, and the six
third-party pages stopped being independent the moment a rule was fixed against them — which is what
they were for, and what makes them training data.

A holdout answers the question the corpus cannot: how the rules do on inputs nobody here tuned
against. It only answers it once. The moment a holdout sample contributes a rule fix, or gets edited
after a disappointing score, it has become training data too, and the answer it gave is the last one
it can give.

Everything below exists to protect that one property.

## The package

A holdout package lives **outside this repository** and is not committed to it. Nothing here
requires the pages to be redistributable, and a package in the tree is a package somebody will
eventually tune against.

```text
fairux-holdout-2026a/
  holdout.json
  pages/…
```

`holdout.json` records, for the package: a `packageId`, who prepared it and when, an `evidenceClass`,
and a `seal`. For each sample: an `id`, the `file` relative to the package root, its `locale`, its
`runtime` — the adapter that reads it — a human `summary`, the rules it `expected` to report with
counts, and the rules it is a declared near miss for.

Three of those fields carry more weight than their size suggests.

**`evidenceClass`** is `external-holdout` or `harness-fixture`, and it is required rather than
defaulted. A package assembled here to test this harness was written by the people who wrote the
rules, which is the one thing a holdout may not be; the field is how a report says so in a value a
reader's tooling can branch on, rather than in a sentence somebody has to notice.

**`negativeFor`** is a claim, not an absence. A page counts as a negative for a rule only when the
manifest says it is one — *this page is built to look like one that rule should fire on, and it must
not*. Incidental silence does not count: a page about train timetables says nothing about a consent
rule's false-positive rate, and counting it would let a package satisfy every negative minimum by
containing unrelated pages.

**`seal`** is one SHA-256 over the labels and every byte they describe. Over both halves, because a
digest of the pages alone would let a label be rewritten after a disappointing result — the edit that
leaves no other trace.

## Preparing and sealing a package

For whoever assembles it, who is not us:

1. Collect pages nobody at this project has seen. Cover both shipped locales and all three
   file-backed adapters — HTML, JSX/TSX, and Figma exports.
2. Label each page **from the page**. What should this page report, read by someone deciding from
   the page rather than from a scan of it? A label copied from the output measures nothing: it
   would report perfect precision on any rule set at all.
3. Declare the near misses. For each rule, the pages that were chosen because they resemble one it
   should fire on.
4. Ask for the digest and paste it in:

   ```bash
   pnpm eval:holdout -- --package ../fairux-holdout-2026a --seal
   ```

   It prints the digest and writes nothing. That is deliberate: a tool that can write into a holdout
   is a tool that can quietly re-seal one after a bad result, and no amount of care in a runbook
   makes that as easy to trust as not having the capability.

The evaluator refuses a package that is short of the per-rule minimums, in either direction, and one
that is missing a locale or an adapter. Both refusals name what is missing and by how much; the
minimum itself is derived from the confidence bound the harness will report, so it is whatever
`scripts/holdout-contract.mjs` computes rather than a number restated here.

## Running an evaluation

```bash
pnpm eval:holdout -- --package ../fairux-holdout-2026a
pnpm eval:holdout -- --package ../fairux-holdout-2026a --json ./holdout-2026a.json
```

The first prints a report. The second also writes the machine-readable run somewhere **outside** the
package — the evaluator refuses a `--json` path inside it.

Every rate is a Wilson score interval with the count it rests on. Wilson rather than the normal
approximation for one reason that matters here: at the extremes, the normal interval has zero width
and reports certainty from a handful of samples, and a point estimate with no interval is the version
that gets quoted. Precision and recall count finding occurrences, exactly as
[the corpus evaluation](../../corpus/README.md) counts them, so the two numbers are comparable — and
a holdout score **lower** than the corpus score is the expected outcome, because one of those two
numbers is partly a measurement of who wrote the pages.

Specificity is reported over declared near misses only. That is the denominator that answers how
often a rule is wrong on a page built to look like one it should fire on, which is the number that
decides whether anyone keeps the tool switched on.

Nothing is pooled across strata. A pooled score hides a locale or an adapter that is entirely wrong.

## After the first evaluation

**The package is frozen.** The pages, the labels, and the rule-pack version it was scored against do
not change. If any of them does, the seal stops matching and the evaluator refuses to score it —
which is the mechanism, not a formality.

Record the run where release evidence already lives: the criterion, with the package id, its seal,
the rule-pack version, and the interval beside every number. Not the point estimates on their own.

## When the numbers are bad

They will be lower than the corpus numbers. That is the expected outcome and not a failure.

What must not happen, in order of how tempting it is:

- **Do not edit a label.** A holdout relabelled after a score is a corpus, and the score it gave was
  its last honest one.
- **Do not add pages to it.** A package that grows until the number improves is a package selected
  on the number.
- **Do not fix a rule against a holdout page and then rescore the same package.** That is precisely
  what happened to the six third-party corpus fixtures, and it is why they cannot close `P7`.

What to do instead: fix the rule, with its own review record and its own version bump, the way
[CONTRIBUTING](../../CONTRIBUTING.md) describes. Add a case to `corpus/` if the defect is one a unit
test cannot hold. Then the holdout is spent, and the next measurement needs a **new** package from
somebody outside this repository — which is the cost of having measured, and the reason a first score
means anything at all.

## Related

- [Release criteria](release-criteria.md) — `P7`, and the four conditions it is written against
- [Evaluation corpus](../../corpus/README.md) — the measurement this one is not
