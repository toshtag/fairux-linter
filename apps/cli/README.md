# fairux

> Explainable, rule-based linter for **dark patterns & unfair UX** — scan HTML and JSX/TSX for UX
> risk signals. Local, no AI.

`fairux` flags interface patterns that may pressure or mislead users — dark patterns, misleading
subscription flows, hidden costs, unfair consent UI, cancellation friction, and scarcity pressure.
Every finding explains **what** was detected, **why** it matters, and **how** to fix it. It runs
entirely on your machine; no network, no AI.

> ⚠️ **Not a legal tool.** Findings are **UX risk signals** for human review, not a judgment that a
> UI is "illegal" or "malicious".

## Install / run

```bash
# one-off, no install
npx fairux scan page.html

# or add it to a project (dev dependency)
npm install --save-dev fairux
pnpm add --save-dev fairux

# then
npm exec fairux -- scan page.html   # or: pnpm exec fairux scan page.html
```

Requires **Node.js `^22.18.0 || >=24.11.0`**.

## Usage

```bash
fairux scan <path>                                # .html → HTML; .tsx/.jsx/.ts/.js → JSX/TSX
fairux scan <dir>                                 # recursively scan a directory
fairux scan '**/*.html'                           # glob pattern (fast-glob; sorted, skips .git/node_modules)
fairux scan -                                     # read from stdin
fairux scan <path> --format json|markdown|sarif   # default: markdown
fairux scan <path> --include-experimental         # also run heuristic rules
fairux scan <path> --config ./fairux.config.json  # explicit config
fairux scan <path> --ignore-config                # ignore any discovered config
fairux scan <path> --fail-on high|medium|low|info # exit 1 if findings meet threshold
```

Output formats: **Markdown** (default), **JSON** (a stable, documented envelope), and **SARIF 2.1.0**
(for GitHub code scanning). The adapter is chosen by file extension; JSX/TSX scanning is static-only.

### Multi-file scanning

Scanning a directory or glob pattern that resolves to multiple files produces a **batch report**
(`FairUxBatchReport`) that preserves per-file metadata (runtime, file path, individual findings)
while providing an aggregate summary. If the target resolves to exactly one file, the CLI emits the
standard single-file `FairUxReport`; that keeps consumers from handling a batch wrapper for a
single result.

### Figma adapter (experimental)

`.figma.json` and `.figjson` files are parsed using the Figma REST API node types. The adapter
infers semantic HTML tags from COMPONENT/INSTANCE node names and `componentPropertyDefinitions`.
This is **experimental** — inference is conservative and confidence is low. Throws on input size
limits (does not silently truncate).

### Scan limits

| Limit                | Value  | Scope          |
| -------------------- | ------ | -------------- |
| Single file size     | 10 MB  | All scans      |
| Stdin size           | 10 MB  | stdin only     |
| Batch file count     | 500    | Directory/glob |
| Batch total bytes    | 100 MB | Directory/glob |
| Batch total findings | 10,000 | Directory/glob |
| Directory depth      | 50     | Directory walk |

A finding looks like:

```markdown
## High

### Pre-checked consent box

- **Rule:** `consent/checked-checkbox`
- **Severity:** high **Confidence:** high
- **What:** A checkbox is checked by default: "Email me product offers and promotions".
- **Why it matters:** Pre-checked boxes opt users in without an active, informed choice.
- **Recommendation:** Leave consent and marketing checkboxes unchecked so users opt in deliberately.
```

## Configuration

Place a `fairux.config.json` near your project — it is auto-discovered upward from the scan target,
up to the repo root. (Executable `fairux.config.{ts,mjs,js,cjs}` is **trusted code** and is only
loaded with an explicit `--config`.)

```json
{
  "configVersion": 1,
  "rules": {
    "consent/missing-reject-option": false,
    "consent/checked-checkbox": { "severity": "low" }
  }
}
```

- `rules[id]: false` (or `{ "enabled": false }`) silences a rule.
- `rules[id].severity` re-grades a rule. Severity overrides do **not** move finding fingerprints,
  so CI baselines stay stable.
- `"includeExperimental": true` enables heuristic rules.

When scanning **untrusted** code (e.g. a fork PR in CI), pass `--ignore-config` so a config the repo
ships can't disable rules or lower severities.

## CI (SARIF → GitHub code scanning)

```bash
fairux scan ./dist/index.html --format sarif --ignore-config > fairux.sarif
```

Upload `fairux.sarif` with `github/codeql-action/upload-sarif`. Severity maps `high → error`,
`medium → warning`, `low | info → note`.

## License

[Apache-2.0](./LICENSE) (see [`NOTICE`](./NOTICE)). FairUX is open core; this CLI is open source.

Source, issues, and full docs: <https://github.com/toshtag/fairux-linter>.
