# Security Policy

## Reporting a vulnerability

Please **do not** open a public issue for security problems.

Instead, report privately via GitHub's **[Report a vulnerability](https://github.com/toshtag/fairux-linter/security/advisories/new)**
(Security → Advisories). Include steps to reproduce, affected version/commit, and impact.

We aim to acknowledge reports within a few days and will coordinate a fix and disclosure timeline
with you.

## Scope / threat model

FairUX **parses untrusted input** — HTML and JSX/TSX source — to produce findings. It does **not**
execute that input, make network requests, or run AI. The areas most relevant to security:

- Parsing untrusted HTML (`@fairux/html`, parse5) and JSX/TSX (`@fairux/ast`, TypeScript compiler).
- Catastrophic-backtracking (ReDoS) in rule patterns: dictionary entries are literal/anchored and
  must not use the `/g` or `/y` flag (enforced by tests).
- The browser extension runs locally with the minimal `activeTab` permission and makes no network
  calls.

### Config files are trusted code

A `fairux.config.{ts,mjs,js,cjs}` is **executable** — loading it runs arbitrary code with your
privileges. FairUX treats executable config as **trusted input**, not untrusted input, and protects
you accordingly:

- **Auto-discovery only ever loads `fairux.config.json`** (data, never executed). So scanning a
  repository — including an untrusted PR — does **not** run any config code that repo ships. If an
  executable `fairux.config.{ts,mjs,js,cjs}` is present, FairUX **warns** that it skipped it rather
  than silently ignoring it.
- **Executable config runs only when you pass `--config <file>` explicitly**, and the CLI prints a
  stderr warning before executing it.
- Auto-discovery is **bounded**: it searches from the scan target up to the repo root (nearest
  `.git`), else the nearest `package.json`, else the start directory — so it finds a monorepo's
  root config but never reaches unrelated parent directories. Auto-discovered JSON must be a
  regular file (no symlink escape) under a 1 MiB cap.

**Even JSON config can distort your results.** A `fairux.config.json` can disable rules, lower
severities, enable experimental rules, or fail the scan with an invalid `configVersion`. This is
not code execution, but when scanning **untrusted** code (e.g. a fork PR in CI) it lets the scanned
branch weaken your scan policy. Use **`--ignore-config`** to isolate FairUX from the checked-out
branch entirely — it is the required setting for untrusted scans, not just defense in depth. Never
point `--config` at a file you don't trust.

Reports of crashes, hangs (ReDoS), sandbox-escape via crafted input, or **auto-execution of config
the user did not opt into** are in scope.
