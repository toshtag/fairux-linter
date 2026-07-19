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

**v0.** Scope: `@fairux/core` + `@fairux/rules` + `@fairux/html` + `@fairux/report` + a `fairux`
CLI that scans **static HTML** and reports findings as JSON / Markdown. (No AI, browser
extension, remote fetching, or dashboard yet — those build on this core later.)

### Packages

| Package | Role |
| --- | --- |
| `@fairux/core` | Runtime-agnostic, **browser-safe** model: types, `scan()`, fingerprinting, helpers |
| `@fairux/rules` | The rule set (10 rules: 8 enabled + 2 experimental), browser-safe |
| `@fairux/html` | Adapter: static HTML → `UiDocument` (parse5) |
| `@fairux/report` | JSON (public-API envelope) + Markdown reporters |
| `@fairux/cli` | The `fairux` command |

### Develop

```bash
pnpm install
pnpm verify   # lint → build → typecheck → test → browser-safety check
```

### Use

```bash
pnpm --filter @fairux/cli build

# Markdown (default) or JSON:
node apps/cli/dist/index.js scan examples/checkout.html
node apps/cli/dist/index.js scan examples/free-trial.html --format json

# Opt into experimental (heuristic) rules:
node apps/cli/dist/index.js scan examples/consent-banner.html --include-experimental
```

The JSON output is a stable `FairUxReport` envelope (`schemaVersion`, `summary`, `findings[]`)
and is treated as a public API.

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

## License

This project is in early development. The repository is **public for transparency**, but
**reuse rights are not granted** until a license is selected (`UNLICENSED`). The license model
will be clarified before broader reuse or distribution.
