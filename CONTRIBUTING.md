# Contributing to FairUX

Thanks for your interest! FairUX is a rule-based UX-risk linter. Bug reports, fixtures of
real-world dark patterns, rule ideas, and PRs are all welcome.

## Getting started

```bash
pnpm install
pnpm verify   # baseline local checks: lint, build-backed typecheck, tests, runtime safety
```

`pnpm verify` is the baseline local gate. Pull-request CI adds build-output isolation, post-build
lint, worktree cleanliness, and rule governance and catalog integrity, in a parallel
verify-and-test lane that finishes in under half a minute. The package and release contracts, both
supported Node.js floors, and Windows
run after the merge instead; see [what CI runs, and when](#what-ci-runs-and-when).

```bash
pnpm verify:full   # the whole local gate, about a minute
```

`pnpm verify:full` is what to run before a pull request that finishes something rather than moves it
along. It composes existing scripts — nothing in it reimplements a check — and adds everything the
fast gate leaves out: the document and third-party fixture checks, build-output isolation, every
generated artifact this repository checks in, and both package smokes. It runs every step and
reports all the failures rather than stopping at the first, and **nothing in it depends on what is
published**: no token, no ownership, and no answer that changes the day a release goes out. That is
checked by resolving each step into the files it runs, not by reading the step's name — two of them
used to run `npm publish --dry-run` one level down, which fails once the version exists on npm.

It is not the same as running no network. `pnpm pack:smoke` installs the packed CLI into a clean
project, so the CLI's five runtime dependencies resolve the way a consumer's would; `pnpm
pack:smoke:sdk` needs nothing, because the SDK ships no dependencies.

It is a superset of the pull-request lane, and
[`tests/unit/verify-full-contract.test.ts`](tests/unit/verify-full-contract.test.ts) fails if a
check is added to `ci.yml` and not to it. The two pack smokes are the gate's own addition — they run
after a merge, not on a pull request, so `pnpm verify:full` is where a completion PR finds a
packaging regression the lane cannot see.

Other useful scripts:

```bash
pnpm build              # build all packages
pnpm test               # builds the CLI, then runs the test suite (Vitest) — safe on a clean checkout
pnpm fairux scan <path> # run the CLI against a file
```

## Scope-specific checks

`pnpm verify` is the baseline for every change. On top of it, run what your change's scope calls
for — not every check on every PR.

| If you changed | Run |
| --- | --- |
| build output, or source broadly | `pnpm build`, `pnpm check:build-output`, `pnpm typecheck`, `pnpm test` |
| documentation | `pnpm check:doc-references` |
| rules or governance | `pnpm rules:reviews:check`, `pnpm rules:catalog:check`, `pnpm eval:corpus:check` |
| a published package, or a release path | `pnpm pack:smoke`, `pnpm pack:smoke:sdk`, `pnpm api:inventory:check`, plus the release-contract command for the path you touched |
| anything, before a completion PR | `pnpm verify:full` |

**Run the plain names.** Several scripts have a `:built` sibling — `test:built`, `typecheck:built`,
`rules:catalog:check:built`, and so on. The plain name is a build followed by the sibling, so it
works against a cold checkout, which is what you want. The sibling skips the build and is for CI,
which builds once and then runs five of them; using it locally on a stale `dist/` checks the last
build rather than your change.

Four of those need a word about what failure means.

**A hand-written `.mjs` or `.d.mts` is a build-output change**, whatever the file does. Those
extensions are what the build emits, so the contract decides by location: they belong in a
`scripts/` directory or in `tests/fixtures/`, and anywhere else they are indistinguishable from a
stray artifact. A test helper that reads the filesystem goes in `scripts/`, not beside the test.

**`check:doc-references` fails when a document names a `pnpm` script or a repository path that is
not there.** The markdown link checker cannot see either — it reads links, not commands and bare
paths. If a document has to mention something that no longer exists, say so in prose rather than in
the notation a reader would copy and run.

When your change touches a paragraph about an issue, add `--issues`. It asks GitHub for the state of
every issue mentioned near unfinished-sounding wording, or under a heading that calls its section
unfinished, and **reports rather than fails**. Read what it lists; a closed issue written up as
pending is how a document misleads without having said anything false at the time.

**`eval:corpus:check` fails when a labelled page stops reporting what it is labelled with.** It
names the page and the rule:

```text
corpus regressions:
  clean-informational-page-en: consent/missing-reject-option reported 1 fewer than labelled
```

That is a regression in your change, and fixing it is part of the change. If the new behaviour is
the correct one, update that page's `expected` in `corpus/manifest.json` and say in the pull request
why the old label was wrong.

## What a rule change is responsible for

Everything in this repository that measures rule quality is either **yours** or **the maintainers'**,
and the split is deliberate.

**Yours, for a rule you add or change:**

- the rule, registered, with its dictionary phrases;
- positive, negative, and Japanese unit fixtures under `packages/rules/test/`;
- a `ruleVersion` bump and an updated review record when what the rule matches changes
  (`pnpm rules:reviews:update` writes it);
- not breaking an existing corpus page — `eval:corpus:check` names any that you did.

**Not yours:**

- adding corpus pages. A new rule does not need one, and a new dictionary locale does not need one;
- the corpus's composition, its balance of positives and negatives, or its coverage of the
  dictionary;
- regenerating the Risk Index calibration, or its collections in `corpus/risk-index-collections.json`.
  `docs/generated/risk-index-calibration.md` is maintainer-owned evidence for the shipped model. If
  a rule change moves it, `calibrate:risk-index:check` says **Maintainer action required** — that
  is a note for a maintainer, not work handed to the pull request;
- the behaviour probe set in `packages/rules/scripts/behaviour-probe.mjs`. It is a frozen regression
  contract: adding a rule, a locale, or a corpus page does not add a probe, and a page joins it only
  when a maintainer decides it catches a guard coming loose;
- the third-party fixtures under `corpus/third-party/`. They exist because markup nobody here chose
  finds defects self-written pages do not, and they are maintainer-owned: their licensing, their
  provenance record, and the decision to add one are not a contributor's problem.

A corpus page is added when something is learned that a unit test cannot hold — a real false
positive, a parser and DOM adapter disagreeing, an interaction between elements. That judgement is a
maintainer's, and reporting the case is enough.

A change to what a rule detects also needs a rule-version bump, an updated review record, and two
regenerated files — a different command each:

```bash
pnpm rules:reviews:update   # rule-review-baseline.json
pnpm rules:catalog          # docs/generated/rule-catalog.{md,json}
```

Include both in the pull request. Nothing else is regenerated: `eval:corpus:check` runs the rules
over the labelled pages and names any that disagree, and there is no corpus artifact to refresh. There is no approval workflow, no environment, and
no value copied by hand: a rule change is an ordinary code change and goes through ordinary review.
The requirement is **checked, not asked for** — `rules:reviews:check` compares a digest of every
dictionary pattern, every rule's execution metadata, every page-context keyword, and what the rules
do to a frozen probe set against what the baseline records. Editing a pattern without bumping a
version used to pass everything; it now fails with the command that fixes it. See
[rule review](docs/maintainers/rule-review.md#the-detection-digest-and-the-hole-it-closes).

**`api:inventory:check` fails when a name leaves the published SDK surface.** An addition passes it
and makes `docs/generated/sdk-api-inventory.json` stale — run `pnpm api:inventory` so the new name
arrives as a diff. A removal is a breaking change and needs more than a regenerated artifact.

For external RulePack work, start with [RulePack authoring](docs/guides/rule-packs.md) and the
[external author example](examples/rule-pack-author). Import only the public SDK entry points from
external examples; internal packages are not a public compatibility contract.

## What CI runs, and when

Two workflows, split by whether they run on the pull-request critical path: the fast CI lane, which
also reruns on `main`, and the post-merge or manually dispatched contract lane.

| Workflow | When | What |
| --- | --- | --- |
| `ci.yml` | every pull request and every push to `main` | `verify` (docs, fixtures, build, build-output contract, lint, typecheck, runtime safety, rule governance, corpus, calibration, SDK surface), `test` in shards |
| `release-paths.yml` | a pull request touching a release-sensitive path | the packed-artifact and bundle-handoff contracts, and both pack smokes — the release checks a pull request can break, on the pull request that breaks them |
| `release-contract.yml` | every push to `main`, and `workflow_dispatch` | the whole suite on both Node floors, both pack smokes, both release preflights, the packed-artifact and bundle-handoff contracts, build idempotency, registry routing, the RulePack author example, both Windows jobs, and the CI time budget |

`release-paths.yml` is filtered by `paths`, so a document, a corpus page, or a test starts nothing
there. Its filter names what the published tarballs are built *from* as well as what describes them:
a byte added to `@fairux/core` reaches the SDK browser bundle whose ceiling `pack:smoke:sdk`
measures, which is how that ceiling was passed between merges once already. `pnpm verify:full` runs
the same two smokes locally.

`release-contract.yml` used to run on pull requests too, and was three quarters of the wait. It does
not now, and `release-paths.yml` is the measured slice that came back: the checks a pull request can
break which nothing else catches, and no more. Everything else in that lane — both Node floors, the
whole suite on each, both Windows jobs, the release preflights, build idempotency — still waits for
the merge, and what the publish workflows re-check against the tag they publish protects the
release, not `main`. The trade is deliberate and it is a trade: a Windows regression is found on the
day it merges rather than 90 seconds at a time on every pull request.
Before tagging a release, run `release-contract.yml` from the Actions tab.

### Why pull-request CI takes about 30 seconds

It was 90 to 110. Where the time goes now, measured on the runner:

| | |
| --- | --- |
| Fixed run overhead — a job with one `echo` finishes at | 5–16s |
| Slowest job (a test shard) | 24–28s |
| — GitHub's own job start and teardown, not a step | ~4s |
| — checkout, `pnpm/action-setup`, `setup-node`, `pnpm install` | ~5s |
| — `pnpm build` | 3s |
| — the tests | ~6s |

**Most of that number is not this repository's.** Fourteen first attempts, decomposed:

| | median | spread |
| --- | --- | --- |
| **The `run:` steps — what this repository decides** | **13s** | **13–15s** |
| `actions/checkout` | 2s | 1–36s |
| `actions/setup-node` (a 57MB pnpm store) | 6s | 4–9s |
| Queue — GitHub finding a machine | 3s | 2–14s |
| Slowest job — the three above, together | 28s | 25–60s |
| Wall clock — what you wait for | 34s | 28–64s |

`actions/checkout` took **36 seconds on one job of a run whose other job took 2**, on a repository of
631 files and 5.4MB. The log says where: `git fetch --depth=1` of a single ref, 08:10:25 to 08:11:00,
while the same fetch in the same run finished in under a second.

**It is a fraction of runner instances, and four measurements say so.** One run, four jobs:
`verify` 1s, `test (3/3)` 1s, `test (1/3)` **36s**, `test (2/3)` **44s** — same repository, same
refspec, same minute. A job in that run running a raw `git fetch` with the identical by-SHA refspec
finished in **300ms**, three times over. Fetching by SHA and by ref name are the same speed
(548/434/503ms, then ~300ms each). And x64, arm64, and Windows degrade at the same rate.

So it is not the git backend for everyone, not the refspec `actions/checkout` chooses, not the
architecture, and not the hour. Two more measurements narrow it further.

**It is not the instance's network either.** On the jobs whose checkout took 36 and 44 seconds,
`actions/setup-node` restored its 57MB pnpm store in the usual 4 — the same as on the fast jobs
(medians 4s and 4s across 64 jobs, correlation −0.25). A 57MB download is fine on a machine where a
1MB `git fetch` is not.

**It is `github.com`'s git service, from some instances, and a different host is unaffected.**
Timed in the same step, on the same machine, before the checkout that followed:

| | `git ls-remote github.com` | `codeload.github.com` tarball |
| --- | --- | --- |
| jobs whose checkout was slow | **13,959ms** | **336ms** |
| jobs whose checkout was fast | 212ms | 315ms |

**So there is a workaround, and it is written down here rather than implemented.** Fetching the
commit's tarball from `codeload.github.com` and reconstructing a repository with `git init && git
add -A && git commit` would reproduce the tracked tree and keep the worktree-cleanliness assertions
meaningful. It would also replace the most security-sensitive step in CI with ten lines of shell, to
route around a fault that first appeared at 07:45Z on 2026-08-03 — before which x64 had 199
checkouts with a maximum of 2 seconds. **A permanent workaround for a fault hours old is the wrong
trade.** If these numbers are still true in a week, it becomes the right one, and the measurement
above is what makes that call answerable rather than a guess.

It also explains why the retry cannot help — a retry runs on the same machine, against the same
host.

**That is why the run is about half a minute three times in four, and not four times in four.**
Across 245 checkouts, 12 exceeded ten seconds — one in twenty — and 22 of 30 runs had none at all.

**The stalls cluster, and that is worth knowing before reasoning about them.** Treating each job as
an independent draw predicts almost no run with two, and there were three:

| stalls in a run | 0 | 1 | 2 | 3 |
| --- | --- | --- | --- | --- |
| observed, 30 runs | 22 | 5 | 2 | 1 |
| if jobs were independent | 23.3 | 6.0 | 0.6 | 0.03 |

So an unlucky run tends to be unlucky in several jobs at once — the same pool, the same moment — and
**removing a job removes a ticket without proportionally removing an unlucky run**. Fewer jobs help
the tail less than `0.95ⁿ` suggests.

**The shard count is the matrix in `ci.yml`, and nowhere else.** This section carried a marked
sentence naming it, checked against the matrix by `ci-budget.test.ts` — the third arrangement of the
same problem, after four claims of three different numbers with no way to tell which had been
updated. A declaration that has to agree with a workflow is still a copy of the workflow; what the
test checks now is that the matrix, the `--shard` denominator, and the job name's denominator agree
with each other. Numbers in the prose here are measurements and history.

The count was chosen for the other reason. The slowest shard was measured at 7.4s at three and 7.6s
at four — the largest single test file is the floor either way — while `verify` did 15 seconds of
`run:` work. `verify` is what the run waits on, so a fourth shard removes nothing from it. A job that
takes nothing off the critical path is a job this lane should not have, whatever it does to the tail.
When a job does draw a slow checkout the wall clock is whatever that job took: not the tests, and not
something a commit here can change.

It is also **not the arm64 runners**, which is worth saying because that was this repository's
choice and will be the first thing suspected. A GitHub-wide slowdown on 2026-08-03 settled it by
accident, because `release-contract.yml` runs the same `actions/checkout` on x64 and Windows at the
same moments:

| | before | during |
| --- | --- | --- |
| x64 (`ubuntu-latest`) | 199 checkouts, median 1s, **max 2s**, none over 10s | 176 checkouts, median 2s, max 41s, **29% over 10s** |
| arm64 (`ubuntu-24.04-arm`) | — | 87 checkouts, median 2s, max 39s, **26% over 10s** |
| Windows | 30 checkouts, median 5s, 1 over 10s | 24 checkouts, median 10s, 46% over 10s |

Three architectures degraded together within the same hour, and **x64 slightly worse than arm64**.
Whatever this is, it is upstream of the runner label. Read this table before reverting an
11-second win on a hunch — and read the `work` row of `scripts/check-ci-budget.mjs` first, which
stayed at 13–15s throughout and is the only row that would have moved if the cause were here.

The first row is the part that does move: across fourteen runs it varies by two seconds, and it is
the only row `scripts/check-ci-budget.mjs` gates.

Every number above is a first attempt. **Re-running one run is not a second sample** — re-runs are
systematically faster, with warm caches and a scheduler that has already found machines, and ten
attempts of a single run once reported 27–30s for a tree whose independent runs were 28–37s.
`scripts/check-ci-budget.mjs` counts first attempts only for that reason.

Eleven things were tried. **Two of them worked**, and it is worth knowing which, because they are not
the ones that sound most promising. Every failure below is an attempt to remove work from a step, or
to outsmart the host; both wins are about the machine the step runs on. Check that first:

| Tried | Result |
| --- | --- |
| **arm64 runners (`ubuntu-24.04-arm`)** | **median 43s → 31.5s** on independent runs. Free for public repositories, same four cores, faster at all of it: the suite unsharded 25s against 28–33s, `pnpm build` 3s against 4s |
| 6 or 8 shards, against the 4 in use at the time | wall-clock mean 35.5s either way; the test step stopped being what the run waits on. The count was reduced afterwards, for the reason above |
| Vitest `--maxWorkers` 6 / 8 / 12 | whole suite 37s / 33s / 39s, against 28s at the default 4. The runner has 4 cores |
| Vitest `--pool=threads` | 16.7s against 17.1s — inside the noise — and one test fails under it |
| **Pinning the Node the runner image already caches (`22.23.1`)** | **~5s per job.** `setup-node` resolves from `/opt/hostedtoolcache` when the exact version is there and downloads a tarball when it is not, and neither declared floor is in the image |
| A floating `node-version: 22` | would reach the same cache, and is a mutable alias this repository refuses — see `action-runtime-contract.test.ts`. The exact pin above gets the win without it |
| `tsdown --workspace`, one process instead of twelve | cannot resolve the per-package `tsconfig.build.json`, and ignores the dependency order the `.d.ts` chain needs |
| Caching `dist/` to skip `pnpm build` | fails open when the cache key misses an input; handing it between jobs serialises them behind `verify` |
| `fetch-depth: 0`, on the theory that a 4.78MiB repository is cheaper fetched whole than as a shallow pack the server has to compute | **Refuted, and by a lot.** Measured on the same runners during the same degradation: `--depth=1` median 2s and 37% over ten seconds, `fetch-depth: 0` median **48s** and 75%. `actions/checkout` at depth 0 fetches every branch ref as well as the full history, and the shallow pack turns out to be the cheap one |
| `GIT_HTTP_LOW_SPEED_LIMIT`/`_TIME` on the checkout, to abort a stalled fetch | **The mechanism works and does not pay.** `actions/checkout`'s fetch *is* wrapped in a 3-attempt retry, and git *does* honour the env vars — proved on the runner with absurd thresholds: `fatal: … Operation too slow`, then `Waiting 11 seconds before trying again`, then 18. Those backoffs are most of the 35s stall the abort was meant to save. Aborting at 10s costs `10 + 11 + retry`, which beats 35s only if the retry lands on a healthy connection — and the stalls **cluster**, so it often will not. Worse: three aborted attempts make the run **red**, and a contributor would rather wait than see CI fail for GitHub's network |
| A cost-aware `sequence.sequencer`, to even out the shards | **Rejected on two weightings, then adopted on a third — it is in `vitest.config.ts` now.** Vitest splits by a hash of the file path into equal counts, so one shard draws the expensive files and runs 10s against the others' 7. Weighting by file size is *worse* than the hash (16.6s → 18.0s simulated), because size barely predicts duration here: **r = 0.15**. Spawn count predicts better (r = 0.63) and still only reaches 15.7s. Neither is test count, which is the better proxy precisely because a test that spawns a process spawns about once — `BalancedSequencer` packs by `tests × 100ms + size / 50`, read from the file itself, so there is no checked-in table to go stale and nothing to drift-check |

**Two things keep this from growing back.** `tests/unit/workflows/ci-budget.test.ts` pins the
pull-request lane's shape — its job list, each job's step count, its shard count, no second
platform, no version matrix, **and the number of packages the install resolves** — and fails on a
change to any of them, so a new job, a new step, or a new dependency is a number somebody has to
raise and a sentence somebody has to write. The lockfile count is there because it was the one
thing neither budget could see: `actions/setup-node` spends 4 to 9 seconds restoring a 57MB pnpm
store, once per job, and the store is that number — so a dependency added carelessly slowed every
job in the lane and failed nothing. `scripts/check-ci-budget.mjs`
covers what a shape budget cannot see: after every merge it reads the last ten first-attempt
pull-request runs and fails when the median **`run:`-step time in the slowest job** goes over 18
seconds, which is how fifty new rule tests would show up. Checkout, `setup-node`, the queue, the
slowest job, and the wall clock are all printed beside it and none is gated, because those are
GitHub's infrastructure rather than anything a commit here decides. It also refuses to pass when
that column is zero — a classifier that swallowed the `run:` steps would otherwise report a
perfectly fast lane for ever — and says when the budget has gone slack, because a ceiling nobody can
reach is not a ceiling.

Six of those seven were attempts to remove work from a step. The one that worked changed the machine
the step runs on, and it was found only after the other six had established that no step had four
seconds left to give. The order was backwards: **the cheapest thing to check about a slow pipeline
is what it is running on.**

## Where information lives

Each kind of information has one authoritative home. Don't copy logs into a document, keep a
parallel task ledger, or restate a contract in a second place — a claim written twice is a claim
that will be corrected once.

| Information | Source of truth |
| --- | --- |
| Where the product is, and what it will not do | [`docs/roadmap.md`](docs/roadmap.md), which indexes the rest |
| Concrete work to implement | GitHub Issues, or an explicitly owner-directed PR for one-off maintenance |
| What happened | PRs, GitHub Actions, and [`CHANGELOG.md`](CHANGELOG.md) |

`docs/` is organized by audience, and which directory a document belongs in is the first question
when adding one:

| Directory | Who opens it | Rule |
| --- | --- | --- |
| `docs/guides/` | somebody using FairUX in their project | task-shaped: it tells you how to do a thing |
| `docs/reference/` | somebody depending on FairUX | contract-shaped: it says what will and will not change |
| `docs/maintainers/` | somebody working on this repository | procedure-shaped: it says what to run, and what refuses |
| `docs/generated/` | nobody, by hand | written by a `pnpm` script and checked in CI |

## Project shape

A pnpm + TypeScript monorepo:

- `packages/core` — the engine (types, `scan()`, fingerprinting). **Browser-safe.**
- `packages/rules` — the rule set + keyword dictionaries (en/ja). **Browser-safe.**
- `packages/html` · `packages/dom` · `packages/ast` · `packages/figma` — input adapters
  (HTML / live DOM / JSX-TSX / Figma JSON).
- `packages/report` — JSON / Markdown / SARIF reporters.
- `packages/config-node` — Node-only config discovery and loading. **Not browser-safe**, by design.
- `packages/sdk` — the public facade (`@fairux/sdk`).
- `apps/cli` · `apps/chrome-extension` · `apps/vscode-extension` — the surfaces.

## Rules of the house

1. **`@fairux/core` and `@fairux/rules` must stay browser-safe.** No Node built-ins, no DOM, no
   parser dependencies — so the same rules can run in a browser extension. This is enforced by
   `scripts/check-runtime-safety.mjs` (part of `pnpm verify`) and by each package's `tsconfig`.
   Anything Node- or parser-specific belongs in an adapter (`@fairux/html`, `@fairux/ast`),
   in `@fairux/config-node`, or in an app.

2. **Findings are risk signals, not verdicts.** No legal/accusatory language ("illegal",
   "malicious", "fraud"). Prefer "may", "review recommended". Detection is deterministic —
   no AI in the engine.

3. **Third-party RulePacks are trusted executable code.** FairUX validates metadata and finding
   output, but it does not sandbox `evaluate()`. Pin and review external RulePack dependencies.

## Code conventions

Formatting is Biome's job (`pnpm lint`). Beyond it:

- Prefer explicit over implicit.
- Don't commit commented-out code.
- Export at file level; avoid barrel re-exports of internal helpers.

**An unused import, variable, or parameter fails `pnpm lint`.** Biome reports the rest of its
findings as warnings, and a warning in a count of fifty-five is a finding nobody reads — these
three are errors so that dead code has to be removed or justified in the same change that adds it.

## Writing a rule

Aim for **few, explainable, high-precision rules** over many noisy ones. A new rule should:

- live under `packages/rules/src/<category>/`, export a `Rule`, and be registered in `registry.ts`;
- put match phrases in `dictionary.ts` (**English + Japanese**; never use the `/g` or `/y` flag);
- ship **positive, negative, and Japanese** fixtures — the negative cases (no false positive)
  matter most;
- scope itself when context-dependent (`appliesTo` page contexts, or local-container checks) to
  avoid firing on unrelated pages.

The JSON output (`FairUxReport`) is a **public API** — additive changes only; see
[`docs/reference/report-schema.md`](docs/reference/report-schema.md).

## Pull requests

- One concrete work item per PR. Link the Issue when one exists; agree on non-trivial new
  features or bug fixes in an Issue first. Maintainer-directed one-off maintenance needs no
  after-the-fact Issue — write `None — owner-directed maintenance` in the template instead.
- Keep PRs focused; conventional-commit-style messages (`feat(rules): …`, `docs: …`) are
  appreciated.
- `pnpm verify` must pass, plus the [scope-specific checks](#scope-specific-checks) for what you
  changed. [Pull-request CI](#what-ci-runs-and-when) is the repository-wide cleanliness check.
- Fill in the [PR template](.github/pull_request_template.md).
- For a non-trivial change, update the closest user-facing document, the type contract, and the
  tests that define the behavior. Don't add a standalone design record; if this repository ever
  develops a concrete, recurring need for one, that decision can be made then.

By contributing you agree your contributions are licensed under the project's
[Apache License 2.0](LICENSE).
