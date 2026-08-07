# FairUX Linter

> Dark-pattern linter for product teams — catch UI that distorts user decisions, before release.

FairUX flags interface patterns that may pressure or mislead users — **dark patterns, misleading
subscription flows, hidden costs, unfair consent UI, missing cancellation paths, and scarcity
pressure**.
It is **rule-based and explainable**: every finding says what was detected, why it matters, and how
to fix it — no AI, no guesswork, runs entirely on your machine.

The same rules run on **static HTML, a live page, JSX/TSX source, and Figma JSON**, from the
**CLI**, **CI** (SARIF), a **browser extension**, and a **VS Code extension**.

> ⚠️ **Not a legal tool.** FairUX does not decide whether a UI is "illegal" or "malicious".
> Findings are **UX risk signals** for human review.

**Status:** beta. Both packages are published on npm's `next` dist-tag — `latest` is intentionally
unchanged on each, so opting in stays explicit. Where the project is and what it deliberately does
not do is in [the roadmap](docs/roadmap.md).

Two things are being aimed at, and they are not the same thing. A **stable `0.x`** means the package
is what a plain `npm install` gives you and does what these documents say; it does **not** promise
API stability, because a `0.x` minor may still break. **`1.0`** is where that promise starts, and it
additionally waits on evidence nobody here can produce: detection quality measured on pages this
project has never tuned against, and a third-party security review. Both gates, row by row, are in
[the release criteria](docs/maintainers/release-criteria.md).

```bash
npm install -g fairux@next   # the CLI
npm install @fairux/sdk@next # the library
```

## Quick start

Requires **Node.js `^22.18.0 || >=24.11.0`** ([`.node-version`](.node-version)).

```bash
pnpm install
pnpm build
pnpm fairux scan examples/free-trial.html            # Markdown (default)
pnpm fairux scan examples/PricingCard.tsx            # also scans JSX/TSX
pnpm fairux scan examples/checkout.html --format json
```

It scans **single files, directories, globs, and stdin**. Output is **Markdown** (default),
**JSON** (a documented envelope), **SARIF 2.1.0**, or a self-contained **HTML** report.
`--include-experimental` turns on the heuristic rules.

A finding looks like this:

```markdown
## High

### Pre-checked consent box

- **Rule:** `consent/checked-checkbox`
- **Severity:** high **Confidence:** high
- **What:** A checkbox is checked by default: "Email me product offers and promotions".
- **Why it matters:** Pre-checked boxes opt users in without an active, informed choice.
- **Recommendation:** Leave consent and marketing checkboxes unchecked so users opt in deliberately.
- **Evidence:**
  - `#newsletter` — "Email me product offers and promotions" (free-trial.html:16)
```

## What it detects

13 rules (11 enabled by default, 2 experimental). All explainable, tuned to keep false positives
low in English and Japanese, and **measured against a labelled corpus rather than asserted** — see
[corpus evaluation](docs/generated/corpus-evaluation.md), whose numbers describe those pages and
nothing beyond them.

| Category | Rules |
| --- | --- |
| **Consent** | pre-checked consent box · accept with no clear reject · bundled (non-granular) consent |
| **Subscription** | free-trial CTA with no renewal disclosure · subscribe CTA with no cancellation terms |
| **Cancellation** | subscription/account page with no cancellation path |
| **Scarcity** | scarcity / urgency phrasing · countdown timers |
| **Hidden cost** | price shown without tax/shipping/fee disclosure (checkout) |
| **Obstruction** | modal with no close control · confirmshaming (guilt-tripping decline options) |
| **Experimental** | accept/reject visual imbalance · hard-to-see modal close (heuristic, off by default) |

Each rule's governance record — maturity, jurisdictions, reviewed sources, known limitations — is in
the [rule catalog](docs/generated/rule-catalog.md), or from `fairux explain <rule-id>`.

## Every report says what it could check

Coverage names which capabilities the input supplied, and which rules ran, were skipped, or were
never enabled — with the reason. A rule that needs evidence your input cannot provide is reported as
**skipped** rather than run and silently unproductive, because "found nothing" and "could not look"
are different answers.

It is a description, not a score: no percentage, no grade, and **no findings is still not a
statement that a page is fair**. See [the report schema](docs/reference/report-schema.md#coverage).
`fairux rules --runtime <html|dom|ast|figma>` answers the same question before a scan.

## Where it runs

### CLI

```bash
pnpm fairux scan <path> --format json|sarif|html
pnpm fairux rules                            # what a scan here would actually run
pnpm fairux explain <rule-id>                # one rule's governance record
pnpm fairux scan-journey flow.json           # a flow you already captured, not a browser
```

The adapter is chosen by file extension — HTML, JSX/TSX, or a Figma export (`.figjson`,
`.figma.json`). Piped input has no extension to read, so `fairux scan -` parses the bytes as HTML;
pass `--stdin-filename Page.tsx` to name the document and pick a different adapter. It must be a
bare file name, not a path: the label is what the report records and what a remediation would carry.
JSX/TSX scanning is **static-only**: JSX-expression
children and dynamic values are treated as unknown rather than asserted, and findings resting on
them are capped at `medium` confidence. Full flags, config discovery, baselines, suppressions, and
`.fairuxignore` are in [the CLI README](apps/cli/README.md).

Three things a scan can do beyond reporting, each deliberately bounded:

- **Propose and apply fixes.** `--fix-dry-run` says what would change; `--fix-write` applies only
  remediations marked `safe`. There is no flag that applies a `review-required` one, and an
  AI-suggested edit can never be marked safe — enforced when the remediation is validated, not when
  it is applied. One built-in rule proposes a fix: `consent/checked-checkbox` offers to delete the
  `checked` attribute from a pre-checked consent box in static HTML. That is the whole of the
  built-in catalogue, deliberately — a fix is offered only where the edit is exact and reading the
  diff is enough to check it. A RulePack may add more.
- **Write a Risk Index.** `--risk-index risk.json` writes a higher-is-worse number with a versioned
  formula — to the file you name, **never to stdout and never to the exit code**. A build goes red
  because of what was found, not because a number crossed a line.
  [What it means, and what it does not](docs/reference/risk-index.md).
- **Scan a flow.** `scan-journey` takes documents you already have and keeps two layers apart:
  findings that exist only *across* steps, and each step's own. **No built-in rule produces a
  cross-step finding** — that layer is the contract, waiting for a RulePack that fills it, so every
  built-in category above is judged one document at a time. FairUX never drives a browser, follows a
  link, or fetches anything.

### CI

`--format sarif` emits SARIF 2.1.0 for GitHub code scanning, mapping `high → error`,
`medium → warning`, and `low | info → note`. Start non-blocking and gate on `high` later — the
**[GitHub Actions guide](docs/guides/github-actions.md)** has the workflow, the fingerprint
semantics, and what the upload Action does with them.

### Browser extension

A Manifest V3 shell running the same rules on a live page, entirely local. It holds only
`activeTab` and `scripting` and runs **no content script**: clicking **Scan this page** injects the
scanner into that one tab, on demand.

```bash
pnpm --filter @fairux/chrome-extension build
# Chrome → chrome://extensions → Developer mode → Load unpacked → apps/chrome-extension/dist
```

The live-DOM adapter catches what a static scan cannot — a checkbox the user just ticked, the values
the rendering engine actually resolved, and whether a control really validates. It scans the main
document only; embedded frames are not scanned.

### VS Code extension

Inline diagnostics for HTML and JSX/TSX in the Problems panel, in-process:

```bash
pnpm --filter fairux-vscode build
# VS Code → Run → Start Debugging, on apps/vscode-extension
```

It runs the default rule set and auto-discovers `fairux.config.json` upward from the document, so
per-project overrides apply in-editor too. Executable config is never auto-executed in the editor.

## Configuration

A `fairux.config.json` is **auto-discovered** upward from the scan target. Executable config
(`fairux.config.{ts,mjs,js,cjs}`) is **trusted code** and is loaded only with an explicit
`--config`, with a warning, because it runs with your privileges.

```ts
import type { FairuxConfig } from "@fairux/sdk";

export default {
  rules: {
    "consent/missing-reject-option": false, // silence a rule
    "consent/checked-checkbox": { severity: "low" }, // re-grade severity
    "obstruction/modal-close-visibility": { enabled: true }, // force-enable an experimental rule
  },
} satisfies FairuxConfig;
```

Severity overrides do not move finding fingerprints, so CI baselines stay stable when you re-grade.
`confidence` is deliberately not overridable — it reflects detection certainty, not policy. Field
reference: [the CLI README](apps/cli/README.md#configuration).

## Programmatic use

```bash
npm install @fairux/sdk@next
```

```ts
import { scanHtml } from "@fairux/sdk/html";

const report = scanHtml('<label><input type="checkbox" checked> Send me marketing offers</label>');
```

For repeated scans, build a scanner once with `createHtmlScanner`; in a browser, `@fairux/sdk/dom`
can additionally read what the rendering engine resolved. Entry points, options, and the strictness
rules are in [the SDK README](packages/sdk/README.md).

**Only `@fairux/sdk`, `@fairux/sdk/html`, and `@fairux/sdk/dom` are public.** Every other workspace
package is implementation and moves without notice. What may change and what may not is in
[compatibility and deprecation](docs/reference/compatibility.md).

To write your own rules, start from [Authoring a RulePack](docs/guides/rule-packs.md) and the
copyable [external author example](examples/rule-pack-author). Third-party RulePacks are **trusted
executable JavaScript, not sandboxed plugins**.

The engine and built-in RulePack are local-only and make no network or AI call. Given
the same normalized input and the same scanner policy, built-in scanning yields the same
findings — locale, enabled packs, experimental rules, and rule or severity overrides are all part of
that policy. Third-party packs are outside that guarantee.

### External products

Purchase Guard-style products are separate applications, not FairUX modes. They may reuse the SDK,
the normalized model, and RulePack composition — but URL, TLS, domain, redirect, and reputation
signals stay in an application-layer namespace, never inside a FairUX finding.

## Documentation

[`docs/roadmap.md`](docs/roadmap.md) is the index: where the project is, what it deliberately does
not do, and a pointer to the document that owns each contract. Beneath it, `docs/guides/` is for
using FairUX, `docs/reference/` is the contracts, `docs/maintainers/` is for running this
repository, and `docs/generated/` is written by scripts and checked in CI.

## Packages

A pnpm monorepo. The engine and rules are **browser-safe** — no Node, no DOM — so the same rules run
on every surface.

| Package | Role |
| --- | --- |
| `fairux` | Public CLI package |
| `@fairux/sdk` | Public programmatic API facade |
| `@fairux/core` · `@fairux/rules` | Internal engine and built-in rules |
| `@fairux/html` · `@fairux/dom` · `@fairux/ast` · `@fairux/figma` | Internal input adapters |
| `@fairux/report` | Internal JSON / Markdown / SARIF / HTML reporters |
| `@fairux/chrome-extension` · `fairux-vscode` | The browser and editor surfaces |

## Contributing

Issues and PRs welcome — see **[CONTRIBUTING.md](CONTRIBUTING.md)**. Quick check:

```bash
pnpm verify   # lint → build-backed typecheck → test → browser-safety check
```

## License

Licensed under the **[Apache License 2.0](LICENSE)** (see [`NOTICE`](NOTICE)).

FairUX is **open core**: this repository — the rules engine, adapters, reporters, CLI, and the
browser and VS Code surfaces — is open source. Any future premium capabilities would live in
separate offerings, not here.
