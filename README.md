# FairUX Linter

> Dark pattern linter for modern product teams.
> Detect UI patterns that may distort user decision-making — before release.

FairUX Linter is a **rule-based, explainable** linter that flags UI patterns which may
distort informed user decision-making (dark patterns / misleading subscription flows /
hidden costs / unfair consent UI / cancellation friction / scarcity pressure).

It is built around a runtime-agnostic core (`@fairux/core`) so the same rules can later run
across multiple surfaces (CLI, Chrome extension, VS Code extension, CI, Figma).

## ⚠️ Disclaimer

FairUX **does not provide legal judgments** and does not determine whether a UI is "illegal"
or "malicious". Findings are **UX risk signals** intended for human review.

## Status

**Post-v0.** Scope: a `fairux` CLI that scans **static HTML** (JSON / Markdown / SARIF), plus a
**live-DOM adapter** and a **Manifest V3 browser-extension shell** that runs the same rules on a
real page. (No AI or remote fetching — the rules engine stays local and browser-safe.)

### Packages

| Package | Role |
| --- | --- |
| `@fairux/core` | Runtime-agnostic, **browser-safe** model: types, `scan()`, fingerprinting, helpers |
| `@fairux/rules` | The rule set (10 rules: 8 enabled + 2 experimental), browser-safe |
| `@fairux/html` | Adapter: static HTML → `UiDocument` (parse5) |
| `@fairux/dom` | Adapter: live browser `Document` → `UiDocument` (browser-safe) |
| `@fairux/ast` | Adapter: JSX/TSX source → `UiDocument` (TypeScript compiler API) |
| `@fairux/report` | JSON (public-API envelope) + Markdown + SARIF reporters |
| `@fairux/cli` | The `fairux` command (HTML + JSX/TSX, adapter by extension) |
| `@fairux/chrome-extension` | Manifest V3 shell: scan the current page, list findings, click to highlight |
| `fairux-vscode` | VS Code extension (MVP): inline diagnostics for HTML + JSX/TSX |

### Develop

```bash
pnpm install
pnpm verify   # lint → build → typecheck → test → browser-safety check
```

### Use

```bash
pnpm build                          # build the CLI once
pnpm scan:example                   # quick demo (scans examples/checkout.html as Markdown)

# Markdown (default), JSON, or SARIF 2.1.0:
pnpm fairux scan examples/checkout.html
pnpm fairux scan examples/free-trial.html --format json
pnpm fairux scan examples/consent-banner.html --format sarif > out.sarif

# Scan a React component too — the adapter is chosen by file extension
# (.html → HTML; .tsx/.jsx/.ts/.js → JSX/TSX via the AST adapter):
pnpm fairux scan examples/PricingCard.tsx

# Opt into experimental (heuristic) rules:
pnpm fairux scan examples/consent-banner.html --include-experimental
```

> JSX/TSX scanning is **static-only**: dynamic values (`checked={x}`, `{label}`) are treated as
> unknown (never asserted), and findings are capped at `medium` confidence — see
> [ADR P6-T2](design/decisions/P6-T2-ast-adapter-contract.md).

The SARIF output is **SARIF 2.1.0**. `high → error`, `medium → warning`, `low|info → note` — the
analyzer-honest mapping (so GitHub code scanning treats `high` findings as PR-blocking by default).
If you want to re-grade a rule, do it in `fairux.config.ts` (severity override) — the SARIF
output then reflects the override. Fingerprints are emitted under the versioned key `fairuxV1`
so baselines transfer between static-HTML and live-DOM runtimes. See
[the ADR](design/decisions/P4-T1-sarif-mapping.md) for the full mapping, and
[the GitHub Actions guide](docs/github-actions.md) for wiring SARIF into code scanning
(start non-blocking; gate on `high` later).

> The legacy form `node apps/cli/dist/index.js scan …` still works — `pnpm fairux …` is just
> a shorter alias defined as a root script.

The JSON output is a stable `FairUxReport` envelope (`schemaVersion`, `summary`, `findings[]`)
and is treated as a public API — see the [report schema](docs/fairux-report-schema.md) for the
full field reference, `id` vs `fingerprint`, and the versioning rules.

### Configure (`fairux.config.*`)

Place a `fairux.config.{ts,mjs,js,cjs,json}` next to your project (auto-discovered upward
from the scan target's directory), or pass `--config <path>`. The shape is `FairuxConfig`
from `@fairux/core` — see [the ADR](design/decisions/P2-T1-fairux-config-contract.md) for the
full contract. Minimal example:

```ts
// fairux.config.ts
import type { FairuxConfig } from "@fairux/core";

const config: FairuxConfig = {
  // Silence a rule entirely:
  rules: {
    "consent/missing-reject-option": false,
    // …or override severity (confidence is intentionally NOT overridable):
    "consent/checked-checkbox": { severity: "low" },
    // Force-enable an experimental rule for one project (bypasses --include-experimental):
    "obstruction/modal-close-visibility": { enabled: true },
  },
};

export default config;
```

Severity overrides do **not** move finding fingerprints, so CI baselines stay stable when
you re-grade a rule. Use `--ignore-config` to skip auto-discovery.

### Browser extension (shell)

A Manifest V3 shell that runs the **same rules** on a live page via `@fairux/dom` — entirely
local (no network, no AI; the only permission is `activeTab`).

```bash
pnpm --filter @fairux/chrome-extension build
# Then in Chrome: chrome://extensions → enable Developer mode →
# "Load unpacked" → select apps/chrome-extension/dist
```

Open any `http(s)` page, click the toolbar icon, **Scan this page** → findings are grouped by
severity; click one to scroll to and highlight the element. Because the DOM adapter reads live
properties, it catches state the static scan can't (e.g. a checkbox the user just ticked).

### VS Code extension (MVP)

Inline FairUX diagnostics while you edit **HTML and JSX/TSX** (`.html`, `.tsx`, `.jsx`, `.ts`,
`.js`) — runs the engine in-process, findings appear in the Problems panel. No Quick Fixes, no
LSP, no AI (see [ADR P5-T2](design/decisions/P5-T2-vscode-mvp.md)). JSX inherits the AST adapter's
static-only / medium-confidence guarantees.

```bash
pnpm --filter fairux-vscode build
# Then in VS Code: Run → Start Debugging (Extension Development Host) loading apps/vscode-extension
```

Severity maps to diagnostic levels (`high → Error`, `medium → Warning`, `low → Information`,
`info → Hint`); rule policy is read from `fairux.config.*` so editor and CI agree.

## License

This project is in early development. The repository is **public for transparency**, but
**reuse rights are not granted** until a license is selected (`UNLICENSED`). The license model
will be clarified before broader reuse or distribution.
