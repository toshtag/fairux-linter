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

### Rule packs are trusted executable code

The FairUX built-in engine and built-in rule pack are local-only, deterministic for the same
normalized input, and make no network or AI calls. That guarantee does not extend to third-party
rule packs. A third-party rule's `evaluate()` function runs as ordinary JavaScript in the caller's
environment; FairUX does not sandbox it. Such code may perform network or filesystem operations,
use global mutable state, or call AI services if the host environment permits it.

Treat third-party rule packs like any other executable dependency: pin package versions, review the
source, preserve lockfile/integrity checks, and do not dynamically download unknown remote packs.
For browser extensions, do not inject arbitrary rule-pack code into pages; bundle reviewed packs and
keep built-in and custom pack provenance in the report.

FairUX validates third-party rule results before report generation. Every custom-rule result
property is read at most once during normalization, and the value from that single read is used for
both validation and the FairUX-owned snapshot. Accessor properties cannot present one value to the
validator and a different value to the report. Accessor failures are converted to `RulePackError`
before fingerprinting, severity summary aggregation, or JSON serialization, so malformed findings
and generic aggregation errors do not leak into public reports.

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
- JSON config is read from an opened file descriptor only. Reads are bounded to at most
  `maxBytes + 1` bytes; a file that grows during reading is rejected. The descriptor is always
  closed, even when a check fails.
- On filesystems that expose stable device and inode numbers (`BigIntStats.dev` / `ino` are
  non-zero), FairUX compares the pre-open path entry, the opened descriptor, and the post-open
  path entry. A mismatch — or a mixed stable/unavailable comparison — fails closed. **On
  platforms where `dev` and `ino` are both zero (e.g. Windows), stable file-identity is not
  available from the OS API; FairUX does not claim regular-file replacement detection on those
  platforms.** The remaining boundaries — non-symlink regular-file checks, descriptor-bound reads,
  byte limits, JSON-only parsing, and strict validation — remain enforced on all platforms.
- The scan target is **resolved once** and the same resolved path is used for config discovery and
  the actual read — so a `symlink/../file` input can't make discovery vet one path while the read
  opens another.
- Auto-discovered JSON is parsed defensively: `__proto__` / `constructor` / `prototype` keys are
  rejected (prototype-pollution hygiene). An explicit `--config` is _intended_ by the user, so it MAY
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
- A local attacker who can rewrite the filesystem _concurrently_ with a scan.
- Limits on the _scanned document_ (max bytes / nodes / depth). These are implemented with
  dedicated limits: single files are capped at 10 MB (checked before reading), directory scans
  are limited to 500 files with max depth 50, and batch total bytes are capped. Pathological
  inputs are rejected before processing.

If you scan untrusted trees, treat the scan target as you would any path you hand to `cat`: point it
only at files you intend to read.

In scope: ReDoS in rule patterns, and **auto-execution of config the user did not opt into**.
