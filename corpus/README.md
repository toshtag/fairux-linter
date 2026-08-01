# Evaluation corpus

Labelled pages, used to measure what the built-in rule set finds and misses. The measured result is
generated into [`docs/generated/corpus-evaluation.md`](../docs/generated/corpus-evaluation.md) and
[`docs/generated/corpus-evaluation.json`](../docs/generated/corpus-evaluation.json), and checked in CI.

```bash
pnpm eval:corpus         # re-measure and rewrite the artifacts
pnpm eval:corpus:check   # fail if the committed artifacts disagree with a fresh run
```

## What this is not

**The numbers describe these pages.** They are not an accuracy claim about the web, about your site,
or about any page nobody here has written. A corpus of 26 hand-written cases can show that a rule
fires where it should and stays quiet where it should not, on 26 pages. It cannot tell you how often
a rule is wrong in the wild, and no number in the generated report should be quoted as if it could.

It is also not a scan score. Nothing here is reported for a page a user scans; this measures the rule
set, once, against a fixed dataset.

## The rule that makes it worth having

**A label says what the page should produce, decided from the page.** When the engine disagrees, the
disagreement is recorded — as a false positive, a false negative, or a tolerated case with a written
reason. A label is never edited to make the output look right.

A corpus whose labels are copied from the output measures nothing. It would report perfect precision
and perfect recall on the day a rule broke, and keep reporting it.

The first run of this corpus recorded a miss, and the miss is still there: see
[issue #121](https://github.com/toshtag/fairux-linter/issues/121).

## Case shape

`manifest.json` holds every case. The pages live in `cases/`.

```jsonc
{
  "id": "consent-pre-checked-marketing-en",
  "file": "cases/consent-pre-checked-marketing-en.html",
  "locale": "en",
  "kind": "positive", // "positive" | "negative"
  "summary": "What is wrong with this page, or why it is clean.",
  "expected": [{ "ruleId": "consent/checked-checkbox", "count": 1 }],
  "tolerated": [{ "ruleId": "…", "why": "Why a reviewer could score this either way." }],
}
```

- **`expected`** is what should be reported. Fewer findings than labelled is a miss; more is a false
  positive, because a duplicate finding is noise someone has to dismiss.
- **`tolerated`** is for a case a reasonable reviewer could score either way. It is credited neither
  way, and `why` is required — without it, "tolerated" is just a way to hide a disagreement.
- **A negative case is one with an empty `expected`.** These are the important half: a rule that
  fires everywhere is worse than one that fires nowhere, and 12 of the 26 cases exist to catch that.

## Scope

- Static HTML, English and Japanese.
- The default rule set. Experimental rules are off, because they are off for every user; measuring
  them here would report a quality number for something nobody runs.
- One page per case. Journeys, forms, and network behaviour are not represented — FairUX cannot
  observe them yet, which the coverage in every report already says.

## Adding a case

1. Write the page. Make it look like a page someone would ship, not a minimal fixture — the rule
   tests already cover minimal fixtures.
2. Label it from the page, before running anything.
3. Run `pnpm eval:corpus` and read the diff. If the engine disagreed, decide honestly which one is
   wrong. If it is the engine, keep the label and open an issue.
