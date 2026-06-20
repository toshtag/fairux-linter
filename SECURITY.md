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
  repository — including an untrusted PR — does **not** run any config code that repo ships. Any
  executable `fairux.config.{ts,mjs,js,cjs}` seen during discovery is **reported** (even when a JSON
  is adopted), never silently skipped.
- **Executable config runs only when you pass `--config <file>` explicitly**, and the CLI prints a
  stderr warning before executing it.
- Auto-discovery is **bounded**: it searches from the scan target up to the repo root (nearest
  `.git`), else the nearest `package.json`, else the start directory — so it finds a monorepo's root
  config but never reaches unrelated parents.
- **The scan target's own safety is checked ALWAYS — before any config logic, independent of
  `--config` and `--ignore-config`.** Neither flag can bypass it. The target must be a regular,
  non-symlink file (a symlinked target could read out-of-project bytes; a FIFO/socket/device could
  hang), and no directory on the path to it may be a **project-escaping symlink** — one whose real
  path leaves the project boundary. This fails closed for a symlinked ancestor (even one whose target
  has its own `.git`) and a symlinked scan directory, while still allowing an *in-project* symlink
  (one resolving to another location inside the same repo boundary, e.g. a monorepo
  `apps/web/src → packages/shared`). A benign in-place system link (e.g. macOS `/var → /private/var`)
  is not flagged.
- Auto-discovered JSON must be a regular, non-symlink file (a symlink — **including a dangling one**
  — is refused, never treated as absent) under a 1 MiB cap. A nearest config that exists but fails
  these checks is a **fail-closed error** (the scan stops), not a silent fallthrough to a different
  config or to defaults. The vetted bytes are read during discovery and parsed as-is, so the file
  can't be swapped between the check and the read.

Auto-discovered JSON is also parsed defensively: `__proto__` / `constructor` / `prototype` keys are
rejected (prototype-pollution hygiene). An explicit `--config` is treated as *intended* by the user,
so it MAY be a symlink — but it is still required to be a regular file (a FIFO can't hang the scan)
under a generous size cap (it can't OOM the process).

**Even JSON config can distort your results.** A `fairux.config.json` can disable rules, lower
severities, enable experimental rules, or fail the scan with an invalid `configVersion`. This is
not code execution, but when scanning **untrusted** code (e.g. a fork PR in CI) it lets the scanned
branch weaken your scan policy. Use **`--ignore-config`** to isolate FairUX from the checked-out
branch entirely — it is the required setting for untrusted scans, not just defense in depth. Never
point `--config` at a file you don't trust.

### Threat-model boundaries (config discovery)

- **Static checkout.** The model is a *static* working tree: a local attacker who can rewrite the
  filesystem *concurrently* with a scan (winning a race inside the `lstat`+read itself, or
  hard-linking a config to out-of-project bytes within the boundary) is **out of scope**. The
  discovery→load TOCTOU window is closed (vetted bytes are parsed as-read), but FairUX is not a
  defense against an attacker with concurrent local write access during the run.
- **Input size / depth.** Limits on the *scanned document* (max bytes / nodes / depth) are tracked
  separately (phase P10-T9). Today, a pathologically deep document is caught and the CLI exits
  non-zero with a clean error — it does not crash or hang — but it is not yet rejected with a
  dedicated "input too deep" message.

Reports of crashes, hangs (ReDoS), sandbox-escape via crafted input, or **auto-execution of config
the user did not opt into** are in scope.
