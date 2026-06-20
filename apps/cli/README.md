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
pnpm exec fairux scan page.html
```

Requires **Node.js ≥ 20**.

## Usage

```bash
fairux scan <path>                                # .html → HTML; .tsx/.jsx/.ts/.js → JSX/TSX
fairux scan <path> --format json|markdown|sarif   # default: markdown
fairux scan <path> --include-experimental         # also run heuristic rules
fairux scan <path> --config ./fairux.config.json  # explicit config
fairux scan <path> --ignore-config                # ignore any discovered config
```

Output formats: **Markdown** (default), **JSON** (a stable, documented envelope), and **SARIF 2.1.0**
(for GitHub code scanning). The adapter is chosen by file extension; JSX/TSX scanning is static-only.

A finding looks like:

```markdown
## High

### Pre-checked consent box
- **Rule:** `consent/checked-checkbox`
- **Severity:** high  **Confidence:** high
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
