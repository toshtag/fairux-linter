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
- The browser extension runs locally and makes no network calls. It requests only `activeTab` +
  `scripting` and ships no static content script: the scanner is injected into a single tab only
  when you click "Scan this page", so it never runs on pages you don't explicitly scan.

### Config files are trusted code

A `fairux.config.{ts,mjs,js,cjs}` is **executable** — loading it runs arbitrary code with your
privileges. FairUX treats executable config as **trusted input**, not untrusted input, and protects
you accordingly:

The single guarantee here is: **FairUX never auto-executes config a scanned repo ships.**

- **Auto-discovery only ever loads `fairux.config.json`** (data, never executed). So scanning a
  repository — including an untrusted PR — does **not** run any config code that repo ships. Any
  executable `fairux.config.{ts,mjs,js,cjs}` seen during discovery is **reported** (even when a JSON
  is adopted), never silently skipped.
- **Executable config runs only when you pass `--config <file>` explicitly**, and the CLI prints a
  stderr warning before executing it.
- Auto-discovery is **bounded** by a purely lexical search: from the scan target's directory up to
  the repo root (nearest `.git`), else the nearest `package.json`, else the start directory — so it
  finds a monorepo's root config but never reaches unrelated parents.
- Auto-discovered JSON must be a regular, non-symlink file (a symlink — **including a dangling one**
  — is refused, never treated as absent) under a 1 MiB cap. A nearest config that exists but fails
  these checks is a **fail-closed error** (the scan stops), not a silent fallthrough to a different
  config or to defaults. The vetted bytes are read during discovery and parsed as-is, so the CLI
  parses exactly what discovery vetted (the path is not re-opened).
- The scan target is **resolved once** and the same resolved path is used for config discovery and
  the actual read — so a `symlink/../file` input can't make discovery vet one path while the read
  opens another.
- Auto-discovered JSON is parsed defensively: `__proto__` / `constructor` / `prototype` keys are
  rejected (prototype-pollution hygiene). An explicit `--config` is *intended* by the user, so it MAY
  be a symlink — but it is still required to be a regular file (a FIFO can't hang the scan) under a
  generous size cap (it can't OOM the process).

**Even JSON config can distort your results.** A `fairux.config.json` can disable rules, lower
severities, enable experimental rules, or fail the scan with an invalid `configVersion`. This is
not code execution, but when scanning **untrusted** code (e.g. a fork PR in CI) it lets the scanned
branch weaken your scan policy. Use **`--ignore-config`** to isolate FairUX from the checked-out
branch entirely — it is the required setting for untrusted scans, not just defense in depth. Never
point `--config` at a file you don't trust.

### Out of scope (explicitly NOT guaranteed)

FairUX is **not a filesystem sandbox** for the scan target. The scan target is whatever path you
pass on the command line; choosing which files to scan is the caller's responsibility. In
particular, the following are **out of scope** for this config-safety work and are not defended
against:

- Confining the scan target to a repository, or rejecting a target reached via an ancestor symlink,
  hard link, bind mount, or Windows junction/UNC path. (Tracked for a future, dedicated design.)
- A local attacker who can rewrite the filesystem *concurrently* with a scan.
- Limits on the *scanned document* (max bytes / nodes / depth). These are tracked separately as
  phase P10-T9. Today a pathologically deep or large document is read as-is; if it exhausts memory
  or the stack the CLI fails, but there is no dedicated input limit yet.

If you scan untrusted trees, treat the scan target as you would any path you hand to `cat`: point it
only at files you intend to read.

In scope: ReDoS in rule patterns, and **auto-execution of config the user did not opt into**.
