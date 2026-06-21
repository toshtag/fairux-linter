# FairUX Linter

> Dark-pattern linter for product teams — catch UI that distorts user decisions, before release.

FairUX flags interface patterns that may pressure or mislead users — **dark patterns,
misleading subscription flows, hidden costs, unfair consent UI, cancellation friction, and
scarcity pressure**. It is **rule-based and explainable**: every finding says what was detected,
why it matters, and how to fix it — no AI, no guesswork, runs entirely on your machine.

The same rules run on **static HTML, a live page (browser), and JSX/TSX source**, from the
**CLI**, **CI** (SARIF), a **browser extension**, and a **VS Code extension**.

> ⚠️ **Not a legal tool.** FairUX does not decide whether a UI is "illegal" or "malicious".
> Findings are **UX risk signals** for human review.

## Quick start

```bash
pnpm install
pnpm build
pnpm fairux scan examples/free-trial.html            # Markdown (default)
pnpm fairux scan examples/PricingCard.tsx            # also scans JSX/TSX
pnpm fairux scan examples/checkout.html --format json
```

A finding looks like this:

```markdown
## High

### Pre-checked consent box
- **Rule:** `consent/checked-checkbox`
- **Severity:** high  **Confidence:** high
- **What:** A checkbox is checked by default: "Email me product offers and promotions".
- **Why it matters:** Pre-checked boxes opt users in without an active, informed choice.
- **Recommendation:** Leave consent and marketing checkboxes unchecked so users opt in deliberately.
- **Evidence:**
  - `#newsletter` — "Email me product offers and promotions" (free-trial.html:16)
```

Output formats: **Markdown** (default), **JSON** (a stable, documented envelope), and
**SARIF 2.1.0** (for GitHub code scanning). `--include-experimental` turns on heuristic rules.

## What it detects

13 rules today (11 enabled by default, 2 experimental). All explainable; tuned to keep false
positives low (English + Japanese phrasing):

| Category | Rules |
| --- | --- |
| **Consent** | pre-checked consent box · accept with no clear reject · bundled (non-granular) consent |
| **Subscription** | free-trial CTA with no renewal disclosure · subscribe CTA with no cancellation terms |
| **Cancellation** | subscription/account page with no cancellation path |
| **Scarcity** | scarcity / urgency phrasing · countdown timers |
| **Hidden cost** | price shown without tax/shipping/fee disclosure (checkout) |
| **Obstruction** | modal with no close control · confirmshaming (guilt-tripping decline options) |
| **Experimental** | accept/reject visual imbalance · hard-to-see modal close (heuristic, off by default) |

Rules can be tuned or silenced per project — see [Configuration](#configuration).

## Use it where you work

### CLI

```bash
pnpm fairux scan <path>                      # .html → HTML; .tsx/.jsx/.ts/.js → JSX/TSX
pnpm fairux scan <path> --format json|sarif
pnpm fairux scan <path> --include-experimental
```

The adapter is chosen by file extension. JSX/TSX scanning is **static-only**: dynamic values
(`checked={x}`, `{label}`) are treated as unknown (never asserted), and those findings are capped
at `medium` confidence. (`node apps/cli/dist/index.js scan …` is the underlying command; `pnpm
fairux …` is a shorter alias.)

### CI (SARIF → GitHub code scanning)

`--format sarif` emits **SARIF 2.1.0**. Severity maps `high → error`, `medium → warning`,
`low | info → note`, so `high` findings can block PRs. Findings carry stable fingerprints
(`fairuxV1`) so baselines persist across runs and runtimes. Start non-blocking and gate on `high`
later — see the **[GitHub Actions guide](docs/github-actions.md)**.

### Browser extension

A Manifest V3 shell that runs the **same rules** on a live page — entirely local (no network, no
AI; the only permission is `activeTab`):

```bash
pnpm --filter @fairux/chrome-extension build
# Chrome → chrome://extensions → enable Developer mode → "Load unpacked" → apps/chrome-extension/dist
```

Open any page, click the toolbar icon, **Scan this page** → findings grouped by severity; click
one to highlight the element. The live-DOM adapter catches state the static scan can't (e.g. a
checkbox the user just ticked).

> **Versioning:** the CLI and the browser extension are versioned **independently**. The CLI's
> canonical version is `apps/cli/package.json`; the extension's is its `manifest.json` version
> (which `report.toolVersion` reads at runtime). They need not match — each is single-sourced
> within its own surface.

### VS Code extension

Inline diagnostics for **HTML and JSX/TSX** in the Problems panel — runs in-process, no AI:

```bash
pnpm --filter fairux-vscode build
# VS Code → Run → Start Debugging (Extension Development Host) on apps/vscode-extension
```

`fairux.config.*` is shared with the CLI, so your editor and CI agree.

## Configuration

Place a `fairux.config.json` near your project — it is **auto-discovered** upward from the scan
target (up to the repo root). Executable config (`fairux.config.{ts,mjs,js,cjs}`) is **trusted
code** and is *not* auto-discovered; load it explicitly with `--config <path>` (you'll get a
one-line stderr warning, since it runs with your privileges). For a typed config, a `.ts` file
passed via `--config` looks like:

```ts
import type { FairuxConfig } from "@fairux/core";

const config: FairuxConfig = {
  rules: {
    "consent/missing-reject-option": false,            // silence a rule
    "consent/checked-checkbox": { severity: "low" },   // re-grade severity
    "obstruction/modal-close-visibility": { enabled: true }, // force-enable an experimental rule
  },
};
export default config;
```

Severity overrides do **not** move finding fingerprints, so CI baselines stay stable when you
re-grade. `confidence` is intentionally not overridable (it reflects detection certainty, not
policy). Use `--ignore-config` to skip auto-discovery. Full field reference:
[report schema](docs/fairux-report-schema.md).

## Packages

FairUX is a pnpm monorepo. The engine and rules are **browser-safe** (no Node, no DOM), so the
exact same rules run on every surface.

| Package | Role |
| --- | --- |
| `@fairux/core` | Runtime-agnostic engine: types, `scan()`, fingerprinting, helpers |
| `@fairux/rules` | The rule set (13 rules) |
| `@fairux/html` | Adapter: static HTML → document model (parse5) |
| `@fairux/dom` | Adapter: live browser `Document` → document model |
| `@fairux/ast` | Adapter: JSX/TSX source → document model (TypeScript compiler API) |
| `@fairux/report` | JSON + Markdown + SARIF reporters |
| `@fairux/cli` | The `fairux` command |
| `@fairux/chrome-extension` | Manifest V3 shell |
| `fairux-vscode` | VS Code extension |

## Contributing

Issues and PRs welcome — see **[CONTRIBUTING.md](CONTRIBUTING.md)**. Quick check:

```bash
pnpm verify   # lint → build → typecheck → test → browser-safety check
```

Design decisions are recorded in [`design/decisions/`](design/decisions/).

## License

Licensed under the **[Apache License 2.0](LICENSE)** (see [`NOTICE`](NOTICE)).

FairUX is **open core**: this repository — the rules engine, adapters, reporters, CLI, and the
browser / VS Code surfaces — is open source. Any future premium capabilities (hosted dashboards,
team/enterprise features, AI-assisted explanations) would live in separate offerings, not here.
