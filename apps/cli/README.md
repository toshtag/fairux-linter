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

Release status: `fairux@0.1.0-beta.1` is package-ready but this repository has not completed the
public npm beta release and clean registry-install verification. The commands below describe the
published-package UX after that release. From this repository, use `pnpm fairux scan ...`.

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
fairux scan <path> --format json|markdown|sarif|html  # default: markdown
fairux scan <path> --include-experimental         # also run heuristic rules
fairux scan <path> --config ./fairux.config.json  # explicit config
fairux scan <path> --ignore-config                # ignore any discovered config
fairux scan <path> --fail-on high|medium|low|info # exit 1 if findings meet threshold

fairux rules                                      # list the rules a scan would run
fairux rules --format json                        # same list, machine-readable
fairux rules --include-experimental               # include heuristic rules

fairux explain <rule-id>                          # what one rule checks, and what it cannot see
fairux explain <rule-id> --format json            # same, machine-readable

fairux scan <path> --rule-pack ./pack.mjs         # load an external RulePack (repeatable)
fairux scan <dir> --no-ignore                     # bypass a discovered .fairuxignore
fairux scan <dir> --write-baseline fairux.baseline.json  # record what is already there
fairux scan <dir> --baseline fairux.baseline.json        # fail on new findings only
fairux scan <dir> --suppress fairux.suppressions.json    # accept individual findings, with reasons
```

Output formats: **Markdown** (default), **JSON** (a stable, documented envelope), **SARIF 2.1.0**
(for GitHub code scanning), and **HTML**. The adapter is chosen by file extension; JSX/TSX scanning
is static-only.

### HTML report

`--format html` writes a **single self-contained file**: no script, no external stylesheet, no font,
no image, no remote URL of any kind. It renders as a build artifact, an email attachment, or in an
air-gapped review — and it cannot report back on what was scanned.

```bash
fairux scan ./dist --format html > fairux-report.html
```

Everything in a finding is untrusted text from the scanned page — evidence snippets are literally
markup FairUX found — so every value is escaped on the only path it can take to the output. There is
no JavaScript in the report at all, which is a property a test can check rather than a promise.

It carries a coverage panel when the report has coverage to show, and a FairUX Risk Index panel when
one was asked for with `--risk-index`. It carries no grade, no good-or-bad verdict, and no
Lighthouse-style chart: those would be the overstatement this project keeps refusing. An empty
report says so in as many words — no findings is not a statement that the page is fair or compliant.

### Listing the rule set

`fairux rules` answers "what will a scan here actually run", under the same `--config`,
`--ignore-config`, and `--include-experimental` inputs `scan` uses. It reports the **effective**
severity after any config override, and why each rule is or is not enabled — "you turned it off" and
"it is experimental and you did not ask" produce the same silence in a scan and are different things
to know.

The decision itself is the engine's, not a second reading of it, so the list cannot disagree with
the scan beside it.

**Enabled is not coverage.** A rule scoped to a page context runs only where the page carries a
matching signal, so an enabled rule is silent on a page it does not apply to. The output shows each
rule's scope and says this in as many words; what a scan actually checked is not something FairUX
reports yet.

### Explaining one rule

`fairux explain consent/checked-checkbox` prints that rule's governance record: maturity, what it
needs from the page, the jurisdictions and official sources the maintainers reviewed, and — first,
above the citations — its **known limitations**.

The limitations are the point. `consent/checked-checkbox` records that a `checked` attribute may not
match runtime state after scripts run, which is the difference between a finding worth acting on and
one worth dismissing. A rule whose record states no limitations says so explicitly; a missing section
would read as a guarantee, and there is none.

Jurisdictions and sources are review context, not a verdict. They record what was read while
deciding the rule was worth shipping. FairUX returns risk signals, not legal judgments.

Why a *specific* finding matters, and what to change, comes with that finding — run a scan.

### Inline suppressions

A comment beside the line accepts one finding, with the argument next to the code it is about:

```html
<!-- fairux-disable-next-line scarcity/scarcity-phrase -- stock count is live from inventory -->
<p>Only 2 left in stock!</p>
```

```jsx
{/* fairux-disable-next-line consent/missing-reject-option -- reject lives in the footer */}
<button>Accept</button>
```

**The reason is required here too.** A directive without one is refused and reported — it does not
silently suppress nothing, because a user who wrote a directive and got silence would believe a
finding was accepted when it was not. A directive that matches nothing is reported the same way.

It applies to **the next line only**, and only to the rule it names. Not "the next finding", which
would skip blank lines and quietly cover something further down.

Available for HTML and JSX/TSX — the inputs that have both comments and line numbers. A live DOM has
comments but no stable lines and a Figma file has neither, so neither supports this. There is
deliberately no file-level `fairux-disable`: a whole file with no findings is indistinguishable from
a whole file nobody looked at.

Suppressed findings and directive problems are recorded in the report as `suppressed` and
`suppressionDiagnostics`, so nothing is hidden.

### Suppressions

Some findings are deliberate: a scarcity phrase where the scarcity is real, a pattern a regulator has
approved for one jurisdiction. Those need an argument attached, not a bulk acceptance.

```json
{
  "schemaVersion": "1",
  "entries": [
    {
      "fingerprint": "a143d03c1e5a1566",
      "ruleId": "scarcity/scarcity-phrase",
      "reason": "Stock count is live from inventory; the scarcity is real.",
      "expiresOn": "2027-01-01"
    }
  ]
}
```

**A reason is required and may not be blank.** A suppression without one is a disabled rule with
extra steps, and `fairux.config.json` already disables rules — so a file containing a reasonless
entry is refused before anything is scanned, naming the entry.

`expiresOn` is optional and enforced. The suppression applies through the whole of that day; after
it, the finding comes back and the lapse is reported. Dates are compared as `YYYY-MM-DD` strings, so
nobody has to decide what timezone a suppression expires in.

Every run prints what was suppressed **and why**, plus entries that have expired and entries that
matched nothing. A suppression nobody can see is a rule that was silently turned off; the argument is
the only thing distinguishing the two.

How this differs from a baseline, deliberately:

| | Baseline | Suppression |
| --- | --- | --- |
| Scope | every finding in one scan | one finding |
| Justification | none — a date | a required reason |
| Expiry | none | optional, and enforced |
| Intent | "we will get to this" | "this is correct here" |

Both can be used together. Suppressions are applied first, so a finding covered by both is attributed
to the one that carries a reason.

There is a third mechanism, and it is applied somewhere else. An
[inline directive](#inline-suppressions) is read by the scanner, so the finding never reaches the
report's `findings` at all — it moves to `suppressed`, with its reason. A suppression file and a
baseline are read by the CLI, after the scan, and subtract from the report it produced.

That difference has one consequence worth knowing before it surprises someone: a finding an inline
directive removed leaves no fingerprint anywhere in the report, so a baseline entry covering that
finding is reported as one the file can drop — while the page still has it.

### Baselines

On an existing codebase the first scan reports everything at once. A baseline records what is
already there so a run fails on **new** findings only.

```bash
fairux scan ./src --write-baseline fairux.baseline.json   # once, and commit the file
fairux scan ./src --baseline fairux.baseline.json --fail-on medium
```

**A baseline is a record of accepted risk, not of resolved risk.** Nothing about writing one makes a
finding less true. The file says so in its own contents, and every baselined run reports on stderr
how many findings it suppressed — including when that number is zero, so "the baseline is empty" and
"the baseline was not applied" stay distinguishable.

Baselined findings that no longer appear are reported too, so the file can shrink. It is **never
rewritten by a normal scan**: a file that updates itself when findings change is a file that never
fails. Rerun `--write-baseline` deliberately.

Findings are matched on `fingerprints.fairuxV1`. That survives a line moving, but **not** the markup
around a finding being restructured — the primary locator is part of the fingerprint, so such a
finding reappears as new. Expect that when refactoring, and re-record rather than assuming the
baseline broke.

`--write-baseline` writes the file and emits no report, for the same reason: a command that both
recorded a baseline and passed would be a command that never fails.

### `.fairuxignore`

A `.fairuxignore` beside your config keeps generated output and vendored code out of a scan. It is
found by walking up from the scan's base — the same way `fairux.config.json` is — and applies to
**directory walks and globs**.

```
# generated output
dist/
build/

vendor/**
!vendor/keep-this.html
```

**An explicitly named file is always scanned**, even when a pattern excludes it. Naming a file is an
instruction, and silently doing nothing in response to one is worse than scanning something you did
not want. Use `--no-ignore` to bypass the file for a whole run.

The grammar is a small subset of gitignore's, and the boundary is stated rather than left to be
discovered:

| Supported | Not supported |
| --- | --- |
| `#` comments, blank lines | character classes (`[a-z]`) |
| `*`, `?`, `**` | backslash escaping |
| leading `/` (anchor to the ignore file's directory) | nested per-directory ignore files |
| trailing `/` (directories and everything under them) | reading `.gitignore` |
| `!` negation, last match wins | |

An unsupported pattern is **refused with its line number** rather than matched approximately: a
pattern you believe excludes something and does not is the failure worth avoiding. For the same
reason, patterns that matched nothing during a run are reported on stderr, and a scan that ends with
no files names the ignore file as the reason.

Only one file is used — the first one found. Git merges nested ignore files per directory; doing that
here would make "why was this skipped" a question with several answers.

`.gitignore` is deliberately not read. A file being untracked is not the same as it being
uninteresting to a linter.

### External RulePacks

`--rule-pack <path>` loads a RulePack and composes it with the built-in one. It is repeatable, and it
works on `scan`, `rules`, and `explain` alike, so all three describe the same set.

```bash
fairux rules --rule-pack ./packs/house-rules.mjs
fairux scan ./dist --rule-pack ./packs/house-rules.mjs --format sarif
```

**A RulePack is executable JavaScript and FairUX does not sandbox it.** It runs with your privileges.
That is why loading is explicit per invocation: there is no auto-discovery and no config key that
loads one, because a config file is found by walking up from the working directory and would make
cloning a repository enough to run its code. Loading prints a warning naming the path, on stderr, so
`--format json` on stdout stays parseable.

The module may export the pack as `default` or as exactly one named export — the
[authoring example](https://github.com/toshtag/fairux-linter/tree/main/examples/rule-pack-author)
uses a named one. Two exported packs are refused rather than resolved by order.

A malformed pack, a duplicate pack id, or a rule id colliding with a built-in one is refused before
anything is scanned. A pack whose own `status` is `experimental` is skipped entirely unless you pass
`--include-experimental` — `fairux rules` shows the composed set, so it will tell you.

Every pack that ran is recorded in the report envelope's `rulePacks` and in SARIF's rule metadata.

### Glob separators

Quote a glob so the shell hands it over unexpanded. `/` works on every platform. On Windows `\` is
accepted too, so `fairux scan "src\*.html"` names the same files as `src/*.html` — neither `cmd.exe`
nor PowerShell expands a pattern, so the CLI is what has to understand it. On Linux and macOS a
backslash keeps its escape meaning, so `a\*.html` names the single file `a*.html`.

UNC, device, and extended-length patterns (`\\server\share\*.html`, `\\?\C:\…`, `\\.\…`) are not
expanded, and are refused with exit code 2 rather than reported as matching nothing. Scan the
directory itself instead — a directory or a direct file on a share is unaffected.

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

The CLI is not a sandbox for untrusted file trees. It reads local files, walks directories and
globs, and may execute trusted config only when explicitly requested. Products that inspect remote
HTML, such as future URL checkers, should pass bounded HTML strings to the SDK from an isolated
process or worker instead of unpacking remote content into arbitrary paths and scanning them with
the CLI. Do not dynamically download and execute third-party RulePacks.

## CI (SARIF → GitHub code scanning)

```bash
fairux scan ./dist/index.html --format sarif --ignore-config > fairux.sarif
```

Upload `fairux.sarif` with `github/codeql-action/upload-sarif`. Severity maps `high → error`,
`medium → warning`, `low | info → note`.

A finding with no source line — a Figma node — is reported at the file that was scanned, with no
line number; code scanning displays it at line 1. A result with no file at all is rejected by code
scanning, which rejects the whole upload rather than the one result, so a live-DOM report is not
uploadable. See the [GitHub Actions guide](https://github.com/toshtag/fairux-linter/blob/main/docs/guides/github-actions.md).

## License

[Apache-2.0](./LICENSE) (see [`NOTICE`](./NOTICE)). FairUX is open core; this CLI is open source.

Source, issues, and full docs: <https://github.com/toshtag/fairux-linter>.
