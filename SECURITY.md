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

Reports of crashes, hangs (ReDoS), or sandbox-escape via crafted input are in scope.
