# FairUX roadmap

Where the project is, what it deliberately does not do, and what is next.

Concrete work items live in GitHub Issues; what happened lives in the commit history and in
[the changelog](../CHANGELOG.md). This page holds only what neither of those answers: the shape of
the product today and the decisions that bound it.

Two boundaries stand above everything below. **Zero findings are never a safety or fairness proof**,
and **third-party RulePacks are trusted executable JavaScript**, not sandboxed plugins.

## Where it is now

| | State |
| --- | --- |
| Engine | Deterministic, browser-safe, no network and no AI. Same rules on every surface |
| Built-in rules | Consent, subscription, cancellation, hidden cost, scarcity, obstruction; experimental rules ship off. [Catalog](generated/rule-catalog.md), generated |
| Adapters | Static HTML, live DOM, JSX/TSX, Figma JSON |
| Surfaces | CLI, SARIF for CI, Chrome extension, VS Code extension |
| Output | JSON, Markdown, SARIF 2.1.0, and a self-contained HTML report |
| `@fairux/sdk` | Published on npm's `latest` dist-tag — a stable `0.x` |
| `fairux` CLI | Published on npm's `latest` dist-tag — a stable `0.x` |

## Two gates, not one

"Leave beta" and "reach 1.0" were the same list until they were separated, and the list was 1.0's —
so a stable `0.x` was blocked on a third-party security review and on a detection-quality
measurement nobody here can produce. That is not a decision anybody made; it is what one list does
when its hardest rows are the ones outside this repository.

| Gate | What it claims | What it does not claim |
| --- | --- | --- |
| **stable `0.x`** | The package is what a plain `npm install` resolves, it does what these documents say, and a break is recorded in the changelog | API stability. A `0.x` minor may break — [compatibility](reference/compatibility.md) says so |
| **`1.0`** | The report envelope, the SDK surface, and the CLI's flags will not break without a major version and a deprecation first | That the rule set is complete, that the Risk Index model is right, or that a clean scan is a safe product |

Row by row, with what each open item still needs, in the
[release criteria](maintainers/release-criteria.md). The two rows that need somebody outside this
repository are `1.0`'s, and they are unchanged by the split.

What each of those means as a contract is written once, in the document that owns it. `docs/` is
organized by audience — the rule for placing a new document is in
[CONTRIBUTING](../CONTRIBUTING.md#where-information-lives), and this is the index:

**`guides/`** — using FairUX in a project.

| | |
| --- | --- |
| Running it in CI, and reading the alerts | [GitHub Actions](guides/github-actions.md) |
| Writing, testing, and publishing your own rules | [Authoring a RulePack](guides/rule-packs.md) |

**`reference/`** — the contracts, which is what to read before depending on something.

| | |
| --- | --- |
| What a report contains, and what `schemaVersion` promises | [report schema](reference/report-schema.md) |
| What may change and what may not | [compatibility and deprecation](reference/compatibility.md) |
| What is trusted, and what FairUX refuses to do | [security boundary](reference/security-boundary.md) |
| What it is tested on | [supported platforms](reference/platforms.md) |
| What the Risk Index number means | [Risk Index models](reference/risk-index.md) |
| What a rule declares about itself | [rule metadata](reference/rule-metadata.md) |

**`maintainers/`** — running this repository: [rule review](maintainers/rule-review.md), the
[SDK](maintainers/release-sdk.md) and [CLI](maintainers/release-cli.md) release runbooks, the
[SARIF canary](maintainers/sarif-canary.md), and the
[release criteria](maintainers/release-criteria.md).

**`generated/`** — written by `pnpm` scripts and checked in CI; never edited by hand. The
[rule catalog](generated/rule-catalog.md), the
[corpus evaluation](generated/corpus-evaluation.md), the
[Risk Index calibration](generated/risk-index-calibration.md), and the
[API inventory](generated/sdk-api-inventory.md).

Three properties are worth naming here because no single document above owns them:

- **Every report says what it was able to check.** Coverage names the capabilities the input
  supplied and accounts for every rule as executed or skipped, with the reason. It is a description,
  not a score: no ratio, no grade.
- **A contract ships before the thing that fills it**, in its own change. Coverage before scoring,
  the Risk Index shape before a model, the remediation schema and the applier before any rule
  proposed an edit, an AI observation type before any provider. Reviewing a shape beside a formula
  makes the interesting half the smaller half.
- **Detection quality is measured on this corpus, not asserted.** A labelled corpus, English and
  Japanese, a minority of its pages written by other projects. The composition and the current
  numbers are in [the corpus evaluation](generated/corpus-evaluation.md), which a script writes —
  not repeated here, because a page that restated them would need editing every time a page is
  added. Rule defects have been found this way repeatedly, including one that made a rule stay
  *silent* on the page it exists for, and one found on its first run by markup nobody here chose.

  The qualifier is load-bearing. Most of the corpus was written by whoever also wrote the rules, and
  the third-party pages stopped being independent the moment a rule was fixed against them — which
  is what they were for, and what makes them training data. Quality on inputs nobody here tuned
  against has never been measured; it is
  [criterion P7](maintainers/release-criteria.md), it is open, and it is a `1.0` gate rather than a
  `0.x` one — because a `0.x` promises no compatibility for that measurement to qualify.

## What is deliberately not built

Each of these is a decision with a reason, not a gap waiting to be filled by whoever gets to it
first.

| Not built | Why, and where it is decided |
| --- | --- |
| The `network` capability | **Refused.** The extension permission it needs does not fit a tool that touches a page only when you click on it — [security boundary](reference/security-boundary.md#the-network-capability-and-why-it-stays-unavailable) |
| The `interaction` capability | Not built. Every scan reports it unavailable and skips the rules needing it |
| A built-in journey rule | The contract ships; writing a rule is a rule change needing its own review. A journey scan reports that the flow was not checked rather than reporting zero |
| Journey SARIF, journey HTML | Refused with reasons: a cross-step finding has no physical location, and the HTML report renders one document |
| A second built-in rule that proposes a fix | One does: `consent/checked-checkbox` removes a pre-checked default in static HTML. Everything else a rule might suggest changes what a page *says*, and no rule can know whether the replacement is true |
| Any AI provider | The contract exists and nothing calls anything. What remains is a decision about sending page content to a third party |
| A sandbox for untrusted file trees | Not built. A RulePack and an executable config both run with your privileges, and both say so |

Two things are *unproven* rather than unbuilt, which is a different claim:

- **That `fairux-risk/1`'s weights are right.** They separate the corpus, and the calibration
  discloses that the severity ratios are not load-bearing on it while the confidence floor is. A
  different formula is a different `modelVersion`, never a quiet edit.
- **That the security boundary holds against someone competent.** There has been no third-party
  review, which is [criterion S6](maintainers/release-criteria.md) — the other `1.0` gate.

## What is next

One milestone is open, and it is waiting on a product and privacy decision rather than on code:
provider code, the configuration that selects one, and an evaluation all follow that decision. That
is not a claim that no other work remains in this repository.

### Public CLI — published, stable `0.x`

`npm install -g fairux`. Published by `publish-cli.yml` through Trusted Publishing with provenance;
the version, and what was read back after it, are in [the changelog](../CHANGELOG.md) and
[the release runbook](maintainers/release-cli.md) rather than repeated here, because a version in
prose is a second copy of something only one place maintains.

`latest` named the `0.0.0-bootstrap.0` placeholder from the moment the name was reserved until the
stable release moved it, so `npx fairux` resolved a deprecated name reservation for the whole beta
line. It resolves the CLI now. `fairux@next` still names the newest beta, because a stable release
does not retract the prerelease channel.

The registry-installed smoke is green on Linux and Windows, on both Node floors, over **both**
channels — the run that turns "published" into "published and verified as installed from the
registry".

Getting here found defects worth naming, because the milestone's own heading once read *repository
side complete* while an external audit was finding them: option contracts that accepted flags they
ignored, filter files validated loosely and read after a scan, a Chrome extension that could
highlight the wrong element, VS Code settings nothing watched, a Figma adapter that trusted its
input, two rules asking for the same edit making `--fix-write` exit 1 on a correct file, a dist-tag
policy npm does not permit, and a release script that could not start `npm` on Windows. Each is
fixed and each has a test that fails without the fix — which is not the same as no defect remaining,
and never will be.

`pnpm verify:full` is the gate that says so from a clean tree: it runs everything CI runs, plus both
package smokes, offline.

### Optional AI augmentation — contract implemented, no provider

Provider-neutral, opt-in, and non-blocking. An AI observation cannot become a finding, cannot fail a
build, and cannot carry anything to a provider that was not on an allowlist.

What remains is a provider, the configuration that selects one, and an evaluation that would say
whether its output is worth reading. Each is a decision about sending page content to a third party,
which is why the boundaries landed first.

Optional coding-agent integrations may be evaluated after the public CLI beta. They must be
separately installable and must not auto-load merely because a contributor cloned this repository.
