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
  repository — including an untrusted PR — does **not** run any config code that repo ships.
- **Executable config runs only when you pass `--config <file>` explicitly**, and the CLI prints a
  stderr warning before executing it.
- Upward auto-discovery stops at the project root (the directory holding `.git` or `package.json`),
  so it won't reach a config in an unrelated parent directory.

When scanning untrusted code in CI, prefer `--ignore-config` (or rely on the JSON-only
auto-discovery) and never point `--config` at a file you don't trust.

Reports of crashes, hangs (ReDoS), sandbox-escape via crafted input, or **auto-execution of config
the user did not opt into** are in scope.
