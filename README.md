# FairUX Linter

> Dark-pattern linter for product teams — catch UI that distorts user decisions, before release.

FairUX flags interface patterns that may pressure or mislead users — **dark patterns,
misleading subscription flows, hidden costs, unfair consent UI, cancellation friction, and
scarcity pressure**. It is **rule-based and explainable**: every finding says what was detected,
why it matters, and how to fix it — no AI, no guesswork, runs entirely on your machine.

The same rules run on **static HTML, a live page (browser), and JSX/TSX source**, from the
**CLI**, **CI** (SARIF), a **browser extension**, and a **VS Code extension**.

> ⚠️ **Not a legal tool.** FairUX does not decide whether a UI is "illegal" or "malicious".
> Findings are **UX risk signals** for human review.

## Quick start

Requires **Node.js `^22.18.0 || >=24.11.0`**. The repository default is recorded in
[`.node-version`](.node-version).

```bash
pnpm install
pnpm build
pnpm fairux scan examples/free-trial.html            # Markdown (default)
pnpm fairux scan examples/PricingCard.tsx            # also scans JSX/TSX
pnpm fairux scan examples/checkout.html --format json
```

### npm users

```bash
npx fairux scan examples/free-trial.html
# or install globally:
npm install -g fairux
fairux scan examples/free-trial.html
```

The CLI scans **single files, directories, globs, and stdin**.
Pass `--format sarif` for CI, `--format json` for programmatic use.

A finding looks like this:

```markdown
## High

### Pre-checked consent box

- **Rule:** `consent/checked-checkbox`
- **Severity:** high **Confidence:** high
- **What:** A checkbox is checked by default: "Email me product offers and promotions".
- **Why it matters:** Pre-checked boxes opt users in without an active, informed choice.
- **Recommendation:** Leave consent and marketing checkboxes unchecked so users opt in deliberately.
- **Evidence:**
  - `#newsletter` — "Email me product offers and promotions" (free-trial.html:16)
```

Output formats: **Markdown** (default), **JSON** (a stable, documented envelope), and
**SARIF 2.1.0** (for GitHub code scanning). `--include-experimental` turns on heuristic rules.

## What it detects

13 rules today (11 enabled by default, 2 experimental). All explainable; tuned to keep false
positives low (English + Japanese phrasing):

| Category         | Rules                                                                                  |
| ---------------- | -------------------------------------------------------------------------------------- |
| **Consent**      | pre-checked consent box · accept with no clear reject · bundled (non-granular) consent |
| **Subscription** | free-trial CTA with no renewal disclosure · subscribe CTA with no cancellation terms   |
| **Cancellation** | subscription/account page with no cancellation path                                    |
| **Scarcity**     | scarcity / urgency phrasing · countdown timers                                         |
| **Hidden cost**  | price shown without tax/shipping/fee disclosure (checkout)                             |
| **Obstruction**  | modal with no close control · confirmshaming (guilt-tripping decline options)          |
| **Experimental** | accept/reject visual imbalance · hard-to-see modal close (heuristic, off by default)   |

Rules can be tuned or silenced per project — see [Configuration](#configuration).

## Use it where you work

### CLI

```bash
pnpm fairux scan <path>                      # .html → HTML; .tsx/.jsx/.ts/.js → JSX/TSX
pnpm fairux scan <path> --format json|sarif
pnpm fairux scan <path> --include-experimental
```

The adapter is chosen by file extension. JSX/TSX scanning is **static-only**: only
statically-written direct JSX elements are analyzed. JSX-expression children
(`{cond && <button/>}`) are dropped (treated as unknown, never asserted), and custom
components are treated as native tags. Dynamic values (`checked={x}`, `{label}`) are
treated as unknown (never asserted), and those findings are capped at `medium`
confidence. (`node apps/cli/dist/index.js scan …` is the underlying command; `pnpm
fairux …` is a shorter alias.)

### CI (SARIF → GitHub code scanning)

`--format sarif` emits **SARIF 2.1.0**. Severity maps `high → error`, `medium → warning`,
`low | info → note`, so `high` findings can block PRs. Findings carry stable fingerprints
(`fairuxV1`) so baselines persist across runs and runtimes. Start non-blocking and gate on `high`
later — see the **[GitHub Actions guide](docs/github-actions.md)**.

### Browser extension

A Manifest V3 shell that runs the **same rules** on a live page — entirely local (no network, no
AI). It uses only `activeTab` + `scripting` and runs **no content script by default**: clicking
**Scan this page** injects the scanner into that one tab on demand, so it never touches pages you
don't ask it to:

```bash
pnpm --filter @fairux/chrome-extension build
# Chrome → chrome://extensions → enable Developer mode → "Load unpacked" → apps/chrome-extension/dist
```

Open any page, click the toolbar icon, **Scan this page** → findings grouped by severity; click
one to highlight the element. The live-DOM adapter catches state the static scan can't (e.g. a
checkbox the user just ticked).

The extension currently scans the main document only; embedded frames are not scanned.

> **Versioning:** the CLI and the browser extension are versioned **independently**. The CLI's
> canonical version is `apps/cli/package.json`. The extension's canonical version is its
> `manifest.json` (which `report.toolVersion` reads at runtime via `chrome.runtime.getManifest()`);
> `apps/chrome-extension/package.json` is a dev-facing mirror that CI keeps in sync. They need not
> match each other — each surface has one canonical source.

### VS Code extension

Inline diagnostics for **HTML and JSX/TSX** in the Problems panel — runs in-process, no AI:

```bash
pnpm --filter fairux-vscode build
# VS Code → Run → Start Debugging (Extension Development Host) on apps/vscode-extension
```

The extension runs the **default rule set** (experimental rules off) and auto-discovers
`fairux.config.json` from the document's directory upward — so per-project severity/disable/experimental
overrides apply in-editor too. Executable config (`.ts/.mjs/.js/.cjs`) is not auto-executed in the editor;
use `fairux.config.json` for editor settings.

## Configuration

Place a `fairux.config.json` near your project — it is **auto-discovered** upward from the scan
target (up to the repo root). Executable config (`fairux.config.{ts,mjs,js,cjs}`) is **trusted
code** and is _not_ auto-discovered; load it explicitly with `--config <path>` (you'll get a
one-line stderr warning, since it runs with your privileges). For a typed config, a `.ts` file
passed via `--config` looks like:

```ts
import type { FairuxConfig } from "@fairux/sdk";

const config: FairuxConfig = {
  rules: {
    "consent/missing-reject-option": false, // silence a rule
    "consent/checked-checkbox": { severity: "low" }, // re-grade severity
    "obstruction/modal-close-visibility": { enabled: true }, // force-enable an experimental rule
  },
};
export default config;
```

Severity overrides do **not** move finding fingerprints, so CI baselines stay stable when you
re-grade. `confidence` is intentionally not overridable (it reflects detection certainty, not
policy). Use `--ignore-config` to skip auto-discovery. Full field reference: see the
[Configuration](#configuration) section above. Programmatic consumers should import public types
from `@fairux/sdk`; the type import requires `@fairux/sdk` to be installed after the first SDK
release or linked from this workspace. Internal packages are not a public compatibility contract.

### Programmatic SDK (publish-ready preview)

`@fairux/sdk` is a publish-ready preview and has not yet been published to npm. Use it from this
workspace, or after the first SDK release, when another product needs deterministic FairUX findings
without shelling out to the CLI:

The SDK follows the same Node.js support contract as the CLI:
**`^22.18.0 || >=24.11.0`**.

```ts
import { scanHtml } from "@fairux/sdk/html";

const report = scanHtml(`
  <label>
    <input type="checkbox" checked>
    Send me marketing offers
  </label>
`);
```

For repeated scans, create a reusable scanner once and pass per-input parse options at scan time:

```ts
import { createHtmlScanner } from "@fairux/sdk/html";

const scanner = createHtmlScanner({
  ruleOverrides: {
    "consent/checked-checkbox": false,
    "obstruction/modal-close-visibility": { enabled: true },
  },
});

const report = scanner.scan(html, { file: "checkout.html" });
```

Custom rule packs compose with the built-in pack:

```ts
import { fairuxBuiltinRulePack } from "@fairux/sdk";
import { scanHtml } from "@fairux/sdk/html";

const report = scanHtml(html, {
  rulePacks: [fairuxBuiltinRulePack, purchaseGuardRulePack],
  ruleOverrides: {
    "purchase-guard/missing-return-policy": { severity: "medium" },
  },
});
```

The one-shot HTML/DOM APIs and reusable HTML/DOM scanners share the same policy options:
`rulePacks`, `includeExperimental`, `ruleOverrides`, `severityOverrides`, `locale`, `toolVersion`,
and `now`. Scanner policy and rule-pack provenance are snapshotted when the scanner is created, so
later mutations to source option objects or rule-pack metadata do not alter future scans.
`severityOverrides` only changes severity; it never enables or disables a rule. When both
`ruleOverrides` and `severityOverrides` target the same rule, `ruleOverrides` controls enabled state
and `severityOverrides` supplies the final severity.
Rule override IDs are validated against the rules provided by the configured rule packs. Unknown IDs
fail scanner construction, which prevents misspelled rule IDs from silently leaving a rule enabled
or unchanged. Custom rule IDs can be overridden only after their RulePack is included in `rulePacks`.
`composeRulePacks()` accepts `includeExperimental` as a boolean only.
Scanner options are strict: unknown option names, non-plain option objects, symbol keys, invalid
`null` values, and unsupported rule IDs fail scanner construction. Only `undefined` triggers SDK
defaults. `null` is treated as invalid input and is never converted to a default value.
RulePack dictionary group names are arbitrary strings stored in prototype-free maps. Names such as
`constructor`, `toString`, and `__proto__` are ordinary dictionary keys, not reserved words.
RulePack arrays must be dense: sparse `rules`, metadata arrays, and dictionary pattern arrays fail
composition with `RulePackError`. Only `undefined` means a RulePack dictionary is absent; `null`,
booleans, numbers, strings, and arrays are invalid dictionary values.
RulePack objects, pack metadata, rules, and rule metadata are strict plain own-property objects:
unknown fields, symbol fields, inherited fields, and class instances fail composition. Rule
execution output is also validated and normalized into fresh data snapshots at runtime, so getters
or later mutation of finding, evidence, locator, source, or reference objects cannot alter the
public report. Every custom-rule result property is read at most once during normalization; the
value from that read is used for both validation and the FairUX-owned snapshot. Accessor properties
cannot present one value to the validator and another to the report, and accessor failures are
converted to `RulePackError` before fingerprinting, summary aggregation, or JSON serialization.
Custom findings must keep `ruleId` and `category` aligned with their rule metadata, and finding IDs
must be unique within a report. Malformed custom findings fail with `RulePackError` before they can
corrupt severity summaries or the public report schema.

The FairUX engine and built-in rule pack are deterministic and local-only: they do not make network
requests or AI calls for the same normalized input. Third-party rule packs are trusted executable
JavaScript and are not sandboxed by FairUX. Pin versions, review source, keep lockfile integrity,
and do not dynamically download unknown packs or inject arbitrary pack code into browser extensions.
The SDK does not add scoring, baselines, suppressions, or automatic fixes.

## Packages

FairUX is a pnpm monorepo. The engine and rules are **browser-safe** (no Node, no DOM), so the
exact same rules run on every surface.

| Package                    | Role                                                            |
| -------------------------- | --------------------------------------------------------------- |
| `fairux`                   | Public CLI package                                             |
| `@fairux/sdk`              | Public programmatic API facade: rule packs, HTML scan, DOM scan |
| `@fairux/core`             | Internal engine implementation detail                          |
| `@fairux/rules`            | Internal built-in rule implementation detail                   |
| `@fairux/html`             | Internal static HTML adapter implementation detail             |
| `@fairux/dom`              | Internal live DOM adapter implementation detail                |
| `@fairux/ast`              | Internal JSX/TSX adapter implementation detail                 |
| `@fairux/report`           | Internal JSON + Markdown + SARIF reporter implementation detail |
| `@fairux/chrome-extension` | Manifest V3 shell                                               |
| `fairux-vscode`            | VS Code extension                                               |

## Contributing

Issues and PRs welcome — see **[CONTRIBUTING.md](CONTRIBUTING.md)**. Quick check:

```bash
pnpm verify   # lint → build → typecheck → test → browser-safety check
```

Design decisions are recorded in [`design/decisions/`](design/decisions/).

## License

Licensed under the **[Apache License 2.0](LICENSE)** (see [`NOTICE`](NOTICE)).

FairUX is **open core**: this repository — the rules engine, adapters, reporters, CLI, and the
browser / VS Code surfaces — is open source. Any future premium capabilities (hosted dashboards,
team/enterprise features, AI-assisted explanations) would live in separate offerings, not here.
