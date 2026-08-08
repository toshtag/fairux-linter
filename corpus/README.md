# Evaluation corpus

Labelled pages, used to measure what the built-in rule set finds and misses. The measured result is
generated into [`docs/generated/corpus-evaluation.md`](../docs/generated/corpus-evaluation.md).
What CI checks is narrower and more useful: every labelled page still reports what its `expected`
says, named page by page. The summary is a maintainer's to refresh.

```bash
pnpm eval:corpus         # re-measure and rewrite the summary
pnpm eval:corpus:check   # fail if a labelled page stopped reporting what it is labelled with
```

## What this is not

**The numbers describe these pages.** They are not an accuracy claim about the web, about your site,
or about any page nobody here has written. A corpus of hand-written cases can show that a rule fires
where it should and stays quiet where it should not, on the pages listed in `manifest.json`. It
cannot tell you how often a rule is wrong in the wild, and no number in the generated report should
be quoted as if it could.

Counts are deliberately not repeated in prose here. The one that used to be — "26 pages" — stayed
after the corpus reached 33, which is how a bound turns into a leftover.

**Most of the detection vocabulary never appears here.** How much does is measured in
[the generated evaluation](../docs/generated/corpus-evaluation.md), which reports the share of
dictionary patterns some page matches and the groups no page reaches at all. Precision and recall
are computed over the rules that fired; they say nothing about phrasings no page contains, and a
corpus written to exercise rules exercises the wordings whoever wrote it thought of.

That share is reported, not chased. Writing a page per unmatched pattern would take it to 1.000 and
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

The cases labelled `adversarial-*` are negatives written to be **hard**: a page that a rule has a
reason to fire on and should not.

- a real per-store stock count of 2, stated as a fact and not as a limit;
- a real enrolment deadline, with the reason it exists and the next intake named;
- a consent choice that is genuinely balanced and uses no accept/reject vocabulary at all;
- a checkout that names VAT and handling in prose instead of a line-item table;
- ordinary declines in the shapes `No, I ...` and `いいえ、…`;
- an account page where cancelling exists and is called "End your plan".

Ordinary negatives show that a rule stays quiet where nothing resembles its signal. These show
whether it stays quiet where something does. **Several found false positives on their first run**,
recorded in the table below with the version each was fixed in, and the numbers moved with them.

That is what they are for. A false positive costs a reader their trust in the tool, and a corpus of
pages that never came close to firing could not have told anyone.

## Case shape

`manifest.json` holds every case. The pages live in `cases/`.

```jsonc
{
  "id": "consent-pre-checked-marketing-en",
  "file": "cases/consent-pre-checked-marketing-en.html",
  "locale": "en",
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
  fires everywhere is worse than one that fires nowhere, and a substantial share of the corpus
  exists to catch that. The contract test requires them to stay one, rather than naming a number
  here that nobody updates.

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
appear more than once — repeating one is exactly how "the same problem across a site" is expressed.
A collection that brought its own pages would be measuring the pages rather than the aggregation.

Collections are not scored for detection: they add no true or false positives, and
`eval:corpus` ignores them. They are read by `pnpm calibrate:risk-index`, which scores each one under
every candidate aggregation and writes the comparison into
[the calibration](../docs/generated/risk-index-calibration.md). Nothing there is adopted — a different
aggregation is a different model version.

## What the adversarial cases found

Three of them reported findings on their first run and every one was wrong. Two confirmed a defect
already suspected — a refusal *opening* followed by a soft negation, with nothing reading what was
being declined — and the third was not suspected at all: a free newsletter signup read as a
subscription page, so the rule asked a paid-plan question of a mailing list. That is the one an easy
corpus could never have found, and the argument for writing hard pages.

The fixes are [#161](https://github.com/toshtag/fairux-linter/issues/161) and
[#162](https://github.com/toshtag/fairux-linter/issues/162), each with its rule-version bump and
review record. What the pages assert now is in their `expected`; what they guard is in their
`summary`.

## Scope

- Static HTML. **One locale per case, and every locale the dictionaries ship must appear**: a page
  in a language no dictionary covers would be silent by construction and would measure the absence
  of a dictionary rather than the quality of a rule. The contract test derives the required set from
  the built dictionaries, so a locale added to the rules is a locale this corpus has to cover.
- **Mostly pages this project wrote**, including the adversarial ones — and, since
  [#203](https://github.com/toshtag/fairux-linter/issues/203), some it did not. Writing a page that
  is hard for your own rules is a better test than writing an easy one, and it is still not the same
  as a page nobody here chose the markup for. Those live in
  [`corpus/third-party/`](third-party/THIRD_PARTY_NOTICE.md), which lists each with its source.
- Whatever the default rule set runs. Measuring rules a user does not get would report a quality
  number for something nobody runs.
- One page per case. A capability no adapter supplies is reported as unavailable in the coverage
  block of every report, so what a static page cannot show is answered there rather than claimed
  here. Journeys appear only as collections of these same pages, which is enough to score a flow and
  not enough to detect anything across one.


## Pages this project did not write

The fixtures in [`third-party/`](third-party/) are reduced copies of files from open-source
repositories, redistributable because their licences say so. `corpus/third-party/provenance.json` is
the record, `corpus/third-party/licenses/` holds each source's licence text verbatim, and
[`THIRD_PARTY_NOTICE.md`](third-party/THIRD_PARTY_NOTICE.md) is **generated** from both —
`pnpm third-party:notice` writes it and `pnpm check:third-party-fixtures` fails if it has drifted.

```bash
pnpm check:third-party-fixtures   # licensed, attributed, reduced, unedited — or the build stops
pnpm third-party:notice           # regenerate the notice from provenance and the licence texts
```

The refusals live in `scripts/third-party-fixtures-contract.mjs` and are exercised against temporary
corpora by `tests/unit/third-party-fixtures-contract.test.ts`. Its negative cases are each a bypass
that used to work: an external review got an unlicensed fixture, an unregistered file and a tracking
pixel past the first version, one edit each. The check keeps its policy in code, lists the directory
from disk, and parses the HTML rather than matching it.

They exist because every other page here was written by whoever also wrote the rules, and an
adversarial page written that way still has its markup chosen by someone who knew what the rule
looks at. These do not: the classes, the element choices and the close-control conventions are other
projects' habits. That paid off on the first run —
[#206](https://github.com/toshtag/fairux-linter/issues/206) is the defect they found, in two
class-naming conventions no page written here had ever used.

What they do **not** establish is representativeness. Design-system examples and component test
pages are not drawn from the same distribution as a shipping checkout, and no number measured here
should be reported as if they were.

`biome.json` excludes `corpus/third-party` from linting, as it already excludes `corpus/cases`. Here the reason
is stronger than tidiness: Biome reports real accessibility findings on them — buttons without a
`type`, links without an `href` — and every one of them is somebody else's page. Fixing them would
edit a licensed copy, and `pnpm check:third-party-fixtures` compares each file against a recorded
hash precisely so that cannot happen quietly.

## Adding a case

1. Write the page. Make it look like a page someone would ship, not a minimal fixture — the rule
   tests already cover minimal fixtures.
2. Label it from the page, before running anything.
3. Run `pnpm eval:corpus` and read the diff. If the engine disagreed, decide honestly which one is
   wrong. If it is the engine, keep the label and open an issue.

For a page from somewhere else, the order is stricter and the reason is the same one: choosing which
page to add *after* seeing what the rules said about it is how a corpus is made to flatter itself.
Fix the source, the commit, and the file in `provenance.json` first; reduce mechanically, with the
same rules for every fixture; check that the findings are identical before and after; and only then
label and run.
