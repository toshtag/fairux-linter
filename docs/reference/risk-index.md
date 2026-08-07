# Risk Index models

Two ship: `fairux-risk/1`, the default, and `fairux-risk/2`, which sees breadth. This document is
the reasoning for both; the evidence is in
[the calibration](../generated/risk-index-calibration.md), which is generated and checked in CI.

## `fairux-risk/1`

The first model. Not the best formula — the first one, chosen so a reader can predict what it will do
without running it.

> The measured behaviour is in [risk index calibration](../generated/risk-index-calibration.md), which
> is generated and checked in CI. This document is the reasoning; that one is the evidence.

The shape it travels in — the three statuses, the null score, the coverage beside it — is the
[Risk Index contract](report-schema.md#risk-index-riskindexreport) and is independent of this
model.

## The formula

For each finding: `severityWeight × confidenceFactor`.
For each input (a file, a journey step): the sum of its findings' contributions.
For the report: **the worst single input**, rounded and capped at 100.

That is the whole thing. There is no curve, no normalisation, and no tuning parameter beyond the two
tables below.

## Every constant, and the sentence that argues for it

### Severity weights — 20 / 10 / 5 / 2

| Severity | Weight |
| --- | --- |
| high | 20 |
| medium | 10 |
| low | 5 |
| info | 2 |

**The ratios are the claim, not the numbers.** One high-severity finding is worth two mediums; a
medium is worth two lows. That mirrors the ladder the rules already use and the SARIF levels they map
to — high → error, medium → warning, low and info → note — so the index cannot disagree with the
report it came from about which finding mattered more.

Doubling per step rather than something gentler, because the failure a risk number is most often
criticised for is many trivial findings outweighing one serious one.

### Confidence factors — 1 / 0.6 / 0.3

| Confidence | Factor |
| --- | --- |
| high | 1 |
| medium | 0.6 |
| low | 0.3 |

Confidence is a property of the evidence rather than of team policy — it is deliberately **not**
overridable in `fairux.config.*` — which makes it the one input here a scanned site cannot tune.

A low-confidence finding counts at roughly a third. Dropping it would hide real risk; counting it
fully would let a heuristic match weigh as much as a checked one. **The calibration shows this
choice is load-bearing**: with low-confidence findings dropped, the separation below fails.

### The aggregation — the worst single input

A sum makes a large site score worse than a small bad one for having more pages. A mean makes one
terrible page vanish among ninety-nine good ones. The worst input says *this is how bad the worst
thing we looked at is*, which is a statement that survives being quoted without its denominator — the
way this number will actually travel.

What it cannot see is **breadth**: one bad page and ten identical bad pages score the same. That is in
the model's limitations rather than in a correction term nobody could justify — and it is now
measured rather than asserted. The
[calibration](../generated/risk-index-calibration.md#aggregation) scores the corpus collections under
every candidate aggregation, and records for each whether it sees breadth and whether it punishes
coverage.

The short version of that table:

| Candidate | Sees breadth | Punishes coverage | One problem page | …repeated five times |
| --- | --- | --- | --- | --- |
| worst input (shipped) | no | no | 20 | 20 |
| worst + share of inputs affected | no | **yes** | 60 | 60 |
| worst + count of inputs affected | yes | no | 20 | 84 |
| worst × log₂ of inputs affected | yes | no | 20 | 32 |
| 90th percentile input | no | **yes** | 20 | 20 |
| sum of inputs | yes | no | 20 | 100 |

Two are disqualified outright: a problem page scanned beside nine clean ones scores *below* the same
page scanned alone, which would make scanning less the way to a better number. That is the failure the
worst-input rule was chosen to avoid, and both denominator-reading candidates walk straight into it.
`sum` sees breadth and brings back the size effect — five copies of one ordinary problem reach 100.

Of the two that pass both tests, **worst + count of inputs affected** climbs too fast to defend: five
copies of one ordinary consent problem reach 84, and ten reach 91. **worst × log₂ of inputs affected**
holds a single input's score exactly where it is and doubles only when the problem is on sixteen
inputs, which is a sentence a reader can check against a number before running it.

That last one is what [`fairux-risk/2`](#fairux-risk2) ships. `fairux-risk/1` is unchanged, and stays
the default.

### The cap — 100

Five high-confidence high-severity findings on one page already reach it. A page with five of those
is not meaningfully safer than one with eight, and pretending to distinguish them would be false
precision. Saturation is stated rather than hidden behind a curve with another constant in it.

## What was measured

Two claims, both generated by `pnpm calibrate:risk-index` and verified in CI.

### Separation

**Among the corpus pages whose problem the rules detected, every one scores above every clean page
the rules stayed quiet on.** The margin is the gap between the lowest detected-problem score and the
highest quiet clean one.

Two sets are excluded, for the same reason in both directions: a scoring claim cannot be made to
carry a detection result.

- A page whose problem was never detected scores zero, and no arrangement of weights can rank it
  above a clean page — there is nothing to weigh. A **recall** failure.
- A clean page a rule fired on scores like a problem page, because the index weighs findings and
  cannot know one was wrong. A **precision** failure.

Both are counted by the [corpus evaluation](../generated/corpus-evaluation.md) and both are listed in
the calibration report rather than averaged away. The second exclusion arrived late: until the corpus
contained adversarial pages it had no false positives, so the exclusion was one-sided and nothing
could show it.

**This is a weak claim, and it is worth saying so.** With those exclusions every remaining clean page
scores zero, so it reduces to "a detected problem scores above nothing". It can fail — a model
scoring a detected finding at zero would break it — but it is not the measurement that would tell you
the weights are right. Nothing here is.

### Sensitivity

The separation is re-measured under six single-change variants of the weights. It survives four:
flattening the severity ladder, making it gentler, making it steeper, and ignoring confidence
entirely. It **fails** under two — dropping low-confidence findings, and suppressing them to 0.05 —
because at least one detected problem page rests entirely on low-confidence evidence.

That is the useful result. The severity ratios are not load-bearing on this corpus, so the separation
is not an argument for them; the confidence floor is, and the calibration is the reason it is 0.3
rather than 0.

## `fairux-risk/2`

The same weights, an aggregation that can see breadth:

```
worst input × (1 + log₂(inputs with findings) / log₂(16))
```

Everything else is `fairux-risk/1`. That is deliberate: the calibration showed the severity ratios
are **not** load-bearing on this corpus, so changing them in the same version would be changing
something on no evidence while claiming the evidence collected for something else.

### The one constant — 16

The number of inputs the same problem has to appear on before the score doubles. Two affected inputs
add a quarter, four add a half, sixteen double it, and one input adds nothing at all.

Logarithmic rather than linear because the interesting difference is between one page and several,
not between forty and fifty; a linear term reaches the cap on any real site and stops saying
anything. Exported as `BREADTH_DOUBLING_INPUTS` so the sentence above and the arithmetic cannot
disagree.

### What it counts, and what it refuses to count

It counts **inputs that carry findings**, and never reads how many were scanned. That is the whole
reason it does not punish coverage: adding ten clean pages adds ten zeros, and zeros cannot lower a
maximum or a count. The obvious alternative — a share of inputs affected — makes scanning less the
way to a better number, which the table above measures rather than assumes.

### What it still cannot see

Ten different problems on one page and one problem on one page score the same, because the breadth
term counts inputs and not distinct problems. And a page whose problem these rules missed is a page
it counts as clean, which is a detection gap wearing a scoring gap's clothes — the
[corpus evaluation](../generated/corpus-evaluation.md) is where that one is counted.

### It is not the default

`fairux-risk/1` is what a bare `computeRiskIndex` returns and what `fairux scan --risk-index` writes.
Two scores are comparable when their `modelVersion` matches and not otherwise, so moving the default
changes what every number written before it meant — a maintainer's decision, not a consequence of a
second model existing.

Until then it is reached explicitly:

```bash
fairux scan ./dist --risk-index risk.json --risk-index-model fairux-risk/2
```

```ts
import { computeRiskIndex, fairuxRiskIndexModelV2 } from "@fairux/sdk";
computeRiskIndex(report, { model: fairuxRiskIndexModelV2 });
```

## What these models are not

- **Not a grade.** No letters, no bands, no colours, no good/bad wording. A grade is a verdict, and
  FairUX does not return verdicts.
- **Not a measurement of harm.** The weights are this model's judgement about relative seriousness,
  versioned so that a later judgement is a different number rather than a quiet change to this one.
- **Not comparable across model versions.** Two scores are comparable when their `modelVersion`
  matches and not otherwise. `fairux-risk/1` and `fairux-risk/2` agree on every single-page input and
  diverge the moment there is more than one, which is exactly the case where comparing them would be
  a mistake.
- **Not a CI gate.** The exit code is a function of findings and `--fail-on`. A build going red
  because a number crossed a threshold would make the threshold the product; a contract test fails if
  the CLI ever reads a score.
- **Not evidence about pages outside the corpus it was calibrated on.** How many pages that is, and
  how many of them this project wrote rather than found, is stated in the
  [generated calibration](../generated/risk-index-calibration.md) — which counts the corpus rather
  than repeating a number somebody typed here once.
- **Not able to tell a wrong finding from a right one.** A false positive raises a score exactly as a
  correct finding does. Two adversarial corpus pages demonstrate it: both are labelled clean, both
  score above zero, and the arithmetic is right in each case — the input is not.
- **Not safe to read a journey's number without knowing where its findings were anchored.** See
  below.

## How a journey scores, and the one thing wrong with it

A journey is scored through its steps: each step is an input, the aggregation picks among them, and
the journey's own cross-step findings land in the pool of the step they are anchored to.

[Issue #135](https://github.com/toshtag/fairux-linter/issues/135) asked three questions about that.
They are measured in
[the calibration](../generated/risk-index-calibration.md#how-a-journey-scores), using a probe rule that
lives in the harness and ships nowhere — the rule set that calibration scanned produced no cross-step
finding to weigh, which is why the questions were unanswerable rather than merely unanswered.

**Is a cross-step finding worth more than a page finding?** No. A medium finding at high confidence
contributes 10 either way. Nothing about crossing a boundary changes a weight, and nothing here
argues it should — "the offer changed between pages" and "this box was pre-checked" are different
kinds of problem, and this model has never claimed to rank kinds.

**Does the journey's own coverage gate the score?** No, and it is the same gate a page gets: the
model requires `structure` and `text`, and does not require `journey`. A model reading a flow
arguably needs more than one reading a page, and this one does not ask for more. Recorded as a
choice, because a gate that appeared only for journeys would refuse to score flows that every step
of could be scored alone.

**Does anchoring decide the number?** **Yes, and this is the answer that matters.** The same probe
finding, from the same rule, differing only in the step it names:

| Anchored to | Score |
| --- | --- |
| nothing — steps only | 20 |
| a step with no findings of its own | 20 |
| the worst step | 30 |

A cross-step finding anchored to a quiet step is worth **nothing at all**. `stepId` is documented as
where a reader should look, and the aggregation reads it as which input the finding belongs to —
two different questions answered by one field. A rule anchoring its finding to the step where the
problem *becomes visible*, which is the natural choice and the one the report schema asks for, can
make its own finding invisible to the score.

**`fairux-risk/1` and `fairux-risk/2` both do this**, because the aggregation is where it happens and
both of them group by `stepId`. Neither changes: a journey finding that formed its own pool rather
than joining a step's is a different aggregation, and a different aggregation is a different
`modelVersion` — with its own argument, and its own calibration over a corpus that contains a journey
rule. What a third model would have to decide is whether "the flow" is an input in its own right, and
nothing measured here settles that.

Until then the honest reading is: **a journey's score is its steps' score, plus whatever the flow's
own findings happen to add to the step they were anchored to.**

## Changing it

Changing any constant changes what a score means, so it changes the model version. The calibration
artifacts are regenerated in the same change, and the sensitivity table is read rather than skimmed:
a variant that newly breaks separation is telling you the corpus, not the model, was doing the work.
