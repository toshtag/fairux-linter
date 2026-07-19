# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/), and the project aims to follow
[Semantic Versioning](https://semver.org/) once packages are published.

## [Unreleased]

First public release in preparation. Highlights of what exists today:

### Added
- **Engine** (`@fairux/core`): runtime-agnostic, browser-safe `scan()` pipeline, document model,
  stable finding fingerprints, NFKC text normalization.
- **Rules** (`@fairux/rules`): 13 explainable rules (11 enabled + 2 experimental) across consent,
  subscription, cancellation, scarcity, hidden-cost, and obstruction — English + Japanese.
- **Adapters**: static HTML (`@fairux/html`), live DOM (`@fairux/dom`), JSX/TSX (`@fairux/ast`).
- **Reporters** (`@fairux/report`): JSON (stable `FairUxReport` envelope), Markdown, SARIF 2.1.0.
- **CLI** (`@fairux/cli`): `fairux scan <path>` with adapter selection by extension; `fairux.config.*`
  for enabling/disabling rules and overriding severity.
- **Surfaces**: a Manifest V3 browser-extension shell and a VS Code extension (Problems-panel
  diagnostics for HTML + JSX/TSX).
- **Docs**: report-schema reference and a GitHub Actions / SARIF guide.

### Notes
- The `FairUxReport` JSON output is treated as a public API.
- Findings are UX **risk signals**, not legal judgments.
