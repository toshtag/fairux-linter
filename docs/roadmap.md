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
| Built-in rules | 13 — 11 enabled by default, 2 experimental and off. [Catalog](generated/rule-catalog.md) |
| Adapters | Static HTML, live DOM, JSX/TSX, Figma JSON |
| Surfaces | CLI, SARIF for CI, Chrome extension, VS Code extension |
| Output | JSON, Markdown, SARIF 2.1.0, and a self-contained HTML report |
| `@fairux/sdk` | Published beta on npm's `next` dist-tag |
| `fairux` CLI | Publish-ready, unreleased |

What each of those means as a contract is written once, in the document that owns it. `docs/` has
four directories, named for who opens them:

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
[1.0 release criteria](maintainers/release-criteria.md).

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
  the Risk Index shape before a model, a remediation schema before anything applies one, an AI
  observation type before any provider. Reviewing a shape beside a formula makes the interesting
  half the smaller half.
- **Detection quality is measured, not asserted.** 56 labelled pages, English and Japanese, six of
  them written by other projects. Nine rule defects have been found this way — including one that
  made a rule stay *silent* on the page it exists for, and one found on its first run by markup
  nobody here chose.

## What is deliberately not built

Each of these is a decision with a reason, not a gap waiting to be filled by whoever gets to it
first.

| Not built | Why, and where it is decided |
| --- | --- |
| The `network` capability | **Refused.** The extension permission it needs does not fit a tool that touches a page only when you click on it — [security boundary](reference/security-boundary.md#the-network-capability-and-why-it-stays-unavailable) |
| The `interaction` capability | Not built. Every scan reports it unavailable and skips the rules needing it |
| A built-in journey rule | The contract ships; writing a rule is a rule change needing its own review. A journey scan reports that the flow was not checked rather than reporting zero |
| Journey SARIF, journey HTML | Refused with reasons: a cross-step finding has no physical location, and the HTML report renders one document |
| A built-in rule that proposes a fix | The model can locate an attribute, so one could. That it does not is the same rule-change gate |
| Any AI provider | The contract exists and nothing calls anything. What remains is a decision about sending page content to a third party |
| A sandbox for untrusted file trees | Not built. A RulePack and an executable config both run with your privileges, and both say so |

Two things are *unproven* rather than unbuilt, which is a different claim:

- **That `fairux-risk/1`'s weights are right.** They separate the corpus, and the calibration
  discloses that the severity ratios are not load-bearing on it while the confidence floor is. A
  different formula is a different `modelVersion`, never a quiet edit.
- **That the security boundary holds against someone competent.** There has been no third-party
  review, which is [criterion S6](maintainers/release-criteria.md).

## What is next

Everything this repository can finish alone is finished, and so is every 1.0 criterion it can reach.
Two milestones are open, and neither is blocked on writing more code here.

### Public CLI beta — repository side complete

Release `fairux` as a public npm beta with the same rigor as the SDK's. Implemented: the release
contract, packed-CLI verification on Linux and Windows across both Node floors and both glob
separator forms, and a registry-installed smoke that fails accurately today because the package does
not exist.

**Blocked on two owner actions on npmjs.com** that this repository cannot perform: creating the
`fairux` package name, and configuring its Trusted Publisher record. Both are in the
[CLI beta release runbook](maintainers/release-cli.md).

### Optional AI augmentation — contract implemented, no provider

Provider-neutral, opt-in, and non-blocking. An AI observation cannot become a finding, cannot fail a
build, and cannot carry anything to a provider that was not on an allowlist.

What remains is a provider, the configuration that selects one, and an evaluation that would say
whether its output is worth reading. Each is a decision about sending page content to a third party,
which is why the boundaries landed first.

Optional coding-agent integrations may be evaluated after the public CLI beta. They must be
separately installable and must not auto-load merely because a contributor cloned this repository.
