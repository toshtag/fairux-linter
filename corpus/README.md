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
or about any page nobody here has written. A corpus of hand-written cases can show that a rule fires
where it should and stays quiet where it should not, on the pages listed in `manifest.json`. It
cannot tell you how often a rule is wrong in the wild, and no number in the generated report should
be quoted as if it could.

Counts are deliberately not repeated in prose here. The one that used to be — "26 pages" — stayed
after the corpus reached 33, which is how a bound turns into a leftover.

**Most of the detection vocabulary never appears here.** The generated evaluation now says how much
does — 92 of 229 dictionary patterns as of writing, and five groups at zero. Precision and recall are
computed over the rules that fired; they say nothing about phrasings no page contains, and a corpus
written to exercise rules exercises the wordings whoever wrote it thought of.

That number is reported, not chased. Writing a page per unmatched pattern would raise it to 1.000 and
teach it to mean nothing, because the pages would be derived from the patterns they test.

**The numbers cover the default rule set only.** Experimental rules are default-off, so the evaluation
runs with `includeExperimental: false` and its precision and recall say nothing about them in either
direction. They are covered by unit tests in `packages/rules/test/`, including the quiet direction —
which they did not have until somebody went looking for what the corpus could not see.

It is also not a scan score. Nothing here is reported for a page a user scans; this measures the rule
set, once, against a fixed dataset.

## The rule that makes it worth having

**A label says what the page should produce, decided from the page.** When the engine disagrees, the
disagreement is recorded — as a false positive, a false negative, or a tolerated case with a written
reason. A label is never edited to make the output look right.

A corpus whose labels are copied from the output measures nothing. It would report perfect precision
and perfect recall on the day a rule broke, and keep reporting it.

The first run of this corpus recorded a miss, and the label stayed put until the rule caught up:
`obstruction/confirmshaming` did not match `No thanks, I don't like saving money`, because no pattern
covered that guilt clause. That is fixed in `obstruction/confirmshaming@1.1.0`
([issue #121](https://github.com/toshtag/fairux-linter/issues/121)), and the case now scores as
labelled.

**The label was never edited to make the output look right.** It sat as a recorded miss through four
milestones, which is the only reason the corpus can be read as a measurement at all.

## Adversarial cases

Seven cases are labelled `adversarial-*`. They are negatives written to be **hard**: a page that a
rule has a reason to fire on and should not.

- a real per-store stock count of 2, stated as a fact and not as a limit;
- a real enrolment deadline, with the reason it exists and the next intake named;
- a consent choice that is genuinely balanced and uses no accept/reject vocabulary at all;
- a checkout that names VAT and handling in prose instead of a line-item table;
- ordinary declines in the shapes `No, I ...` and `いいえ、…`;
- an account page where cancelling exists and is called "End your plan".

Ordinary negatives show that a rule stays quiet where nothing resembles its signal. These show
whether it stays quiet where something does. **Three of the seven found false positives on their
first run**, and the numbers moved with them: precision on this corpus is no longer 1.

That is what they are for. A false positive costs a reader their trust in the tool, and a corpus of
pages that never came close to firing could not have told anyone.

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

## Collections

`collections` groups cases the manifest already labels into **multi-input** sets and **journeys**.
They exist for one question the single-page cases cannot ask: how per-input scores combine.

```jsonc
{
  "id": "breadth-problem-page-repeated",
  "kind": "multi-input", // "multi-input" | "journey"
  "summary": "Why this grouping exists, and what it makes visible.",
  "caseIds": ["consent-pre-checked-marketing-en", "consent-pre-checked-marketing-en"],
}
```

**A collection introduces no new pages.** It names cases that are already labelled, and a case may
appear more than once — repeating one is exactly how "the same problem on five pages" is expressed.
A collection that brought its own pages would be measuring the pages rather than the aggregation.

Collections are not scored for detection: they add no true or false positives, and
`eval:corpus` ignores them. They are read by `pnpm calibrate:risk-index`, which scores each one under
every candidate aggregation and writes the comparison into
[the calibration](../docs/generated/risk-index-calibration.md). Nothing there is adopted — a different
aggregation is a different model version.

## What the adversarial cases found

Recorded rather than relabelled, and each one has an issue:

| Case | Rule | Reported | Should have |
| --- | --- | --- | --- |
| `adversarial-neutral-decline-no-i-en` | `obstruction/confirmshaming` | ~~3~~ 0 | fixed in `@1.1.0` — [#161](https://github.com/toshtag/fairux-linter/issues/161) |
| `adversarial-neutral-decline-iie-ja` | `obstruction/confirmshaming` | ~~2~~ 0 | fixed in `@1.1.0` — [#161](https://github.com/toshtag/fairux-linter/issues/161) |
| `adversarial-neutral-decline-no-i-en` | `subscription/cta-without-cancellation-context` | ~~1~~ 0 | fixed in `@1.1.0` — [#162](https://github.com/toshtag/fairux-linter/issues/162) |

All three are fixed, and the two kinds of finding are worth keeping apart. The first two confirmed a
defect that was already suspected: both patterns matched a refusal *opening* followed by a soft
negation and never read what was being declined. **The third was not suspected at all** — a free
newsletter signup read as a subscription page, so the rule asked a paid-plan question of a mailing
list. That is the one an easy corpus could never have found, and the argument for writing hard pages.

Four of the seven are quiet: the factual inventory count, the factual deadline, the unusually worded
balanced consent, and the checkout that discloses its fees in prose. Those are the cases that say
something about the rules holding up, and they only say it because the three beside them did not.

## Scope

- Static HTML, English and Japanese. **A third locale is not here**: the dictionaries ship `en` and
  `ja`, so pages in any other language would be silent by construction and would measure the absence
  of a dictionary rather than the quality of a rule.
- **Pages this project wrote**, including the adversarial ones. Writing a page that is hard for your
  own rules is a better test than writing an easy one, and it is still not the same as a page nobody
  here chose the markup for — [issue #203](https://github.com/toshtag/fairux-linter/issues/203).
- The default rule set. Experimental rules are off, because they are off for every user; measuring
  them here would report a quality number for something nobody runs.
- One page per case. Forms and network behaviour are not represented — FairUX cannot observe them
  yet, which the coverage in every report already says. Journeys appear only as collections of these
  same pages, which is enough to score a flow and not enough to detect anything across one: the
  built-in rule set has no journey rule.


## Adding a case

1. Write the page. Make it look like a page someone would ship, not a minimal fixture — the rule
   tests already cover minimal fixtures.
2. Label it from the page, before running anything.
3. Run `pnpm eval:corpus` and read the diff. If the engine disagreed, decide honestly which one is
   wrong. If it is the engine, keep the label and open an issue.
