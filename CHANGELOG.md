# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/), and the project aims to follow
[Semantic Versioning](https://semver.org/) once packages are published.

## [Unreleased]

First public release in preparation. Highlights of what exists today:

### Security
- **Config auto-discovery no longer executes untrusted code.** Previously, scanning a directory
  auto-discovered and ran `fairux.config.{ts,mjs,js,cjs}` via `jiti`, so a config shipped in an
  untrusted repo/PR could execute arbitrary code with the scanning user's (or CI runner's)
  privileges. Now:
  - The **scan target's own safety** is checked first, ALWAYS — independent of `--config` /
    `--ignore-config` (neither flag can bypass it). A symlinked or non-regular (FIFO/socket/device/
    directory) target, or one reached through a project-escaping symlink, fails closed before the
    file is opened — so it can't read out-of-project bytes or hang.
  - Auto-discovery loads **only `fairux.config.json`** (data, never executed); an executable config
    seen during discovery is reported (warning) instead of running — even when a JSON is adopted
    elsewhere.
  - Executable config runs **only via an explicit `--config <path>`**, with a stderr trust warning
    printed before import.
  - Discovery is bounded to the repo root (nearest `.git`) / nearest `package.json` / start dir, so
    it finds a monorepo's root config but never reaches unrelated parents. It refuses to cross a
    **project-escaping symlink**: no directory on the path to the scan target may be a symlink whose
    real path leaves the **project boundary** — so a monorepo `apps/web/src → packages/shared` (still
    under the repo root) is allowed, while a symlinked ancestor pointing out of the project (even one
    whose target has its own `.git`, and even when NO `.git`/`package.json` marker exists) fails
    closed. A benign in-place system link (`/var → /private/var`) is not flagged. The whole boundary
    + escape analysis is a single linear (O(path-depth)) walk, so a deep path can't make it slow.
    Auto-discovered JSON must be a regular, non-symlink file (a symlink — **including a dangling
    one** — is refused, never treated as absent) under a 1 MiB cap. A nearest config that exists but
    fails these checks is a **fail-closed error**, not a silent fallthrough. The vetted bytes are
    read during discovery and parsed as-is, closing the discovery→load TOCTOU window.
  - JSON config is parsed defensively: `__proto__` / `constructor` / `prototype` keys are rejected
    at any depth. An explicit `--config` may be a symlink (user-named) but must be a regular file
    under a cap (a FIFO can't hang the scan, a huge file can't OOM it).
  - Warning/error paths strip C0/C1 control chars and Unicode bidi controls from user-derived paths;
    a non-`Error` throw from an executable config no longer crashes the error reporter.
  - **Behavior change:** an existing `fairux.config.ts` (etc.) relied on for auto-discovery is no
    longer loaded automatically — pass `--config` or convert it to `fairux.config.json`.

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
