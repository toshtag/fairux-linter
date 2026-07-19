# @fairux/sdk

Public SDK facade for deterministic FairUX scanning and rule-pack composition.

Release status: publish-ready preview. This package has not yet been published to npm.
The examples below work from this workspace or after the first SDK release.

Requires Node.js `^22.18.0 || >=24.11.0`.

```ts
import { scanHtml } from "@fairux/sdk/html";

const report = scanHtml(`
  <label>
    <input type="checkbox" checked>
    Send me marketing offers
  </label>
`);
```

Use reusable scanners when you need to scan many inputs with the same rule policy:

```ts
import { createDomScanner } from "@fairux/sdk/dom";
import { createHtmlScanner } from "@fairux/sdk/html";

const htmlScanner = createHtmlScanner({
  ruleOverrides: {
    "consent/checked-checkbox": false,
    "obstruction/modal-close-visibility": { enabled: true },
  },
  severityOverrides: {
    "consent/missing-reject-option": "high",
  },
});

const htmlReport = htmlScanner.scan(html, { file: "checkout.html" });

const domScanner = createDomScanner({ includeExperimental: true });
const domReport = domScanner.scan(document, {
  root: document.querySelector("#consent-modal") ?? undefined,
  url: location.href,
});
```

The one-shot APIs (`scanHtml`, `scanDom`) and reusable scanners (`createHtmlScanner`,
`createDomScanner`) accept the same policy options:

- `rulePacks`
- `includeExperimental`
- `ruleOverrides`
- `severityOverrides`
- `locale`
- `toolVersion`
- `now`

`ruleOverrides` match CLI config semantics: `false` disables a rule, `{ enabled: true }`
force-enables a rule including experimental rules, and `{ severity: "low" }` re-grades severity
without changing fingerprints. `severityOverrides` is a shorthand for severity-only policy.
It only changes severity and never enables or disables a rule. When both options target the same
rule, `ruleOverrides` controls enabled state and `severityOverrides` supplies the final severity.
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
Scanner `locale` values and RulePack dictionary locale keys use deterministic RFC 5646 syntax
validation for BCP 47 tags, including extension, private-use, and grandfathered tags. Validation is
syntactic only; it does not use host `Intl` support and does not imply dictionary coverage for that
locale. Duplicate variants are rejected case-insensitively, and duplicate extension singletons are
also rejected. IANA registry membership and extlang prefix relationships are not validated.
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
RulePacks can declare namespaced taxonomy metadata for external categories and page contexts.
Built-in categories do not need declarations; external categories such as
`purchase-guard/return-policy` must be declared in `RulePack.taxonomy.categories` before a rule can
use them. Category parents may reference a built-in category or another category from the same
RulePack only. Scoped npm-style pack IDs such as `@purchase-guard/jp-commerce` own the
`purchase-guard/...` taxonomy namespace.
External page contexts can be supplied per HTML or DOM scan when they are declared by the configured
RulePack taxonomy:

```ts
const report = scanHtml(html, {
  rulePacks: [fairuxBuiltinRulePack, purchaseGuardRulePack],
  pageContexts: [{ context: "purchase-guard/checkout-form", confidence: "high" }],
});
```

Rules observe page contexts through `ctx.getPageContexts()`. Every public scanner validates and
canonicalizes document page-context signals at the scanner boundary. The returned signals are sorted
by context ID using UTF-16 code-unit ascending order. When the same context is detected and supplied,
the highest confidence wins; equal-confidence ties keep the earlier signal, with adapter-detected
signals merged before caller-supplied signals.

`RulePack.taxonomy` is optional authoring metadata. `composeRulePacks().taxonomy` and
`scanner.taxonomy` are validated output snapshots with always-present `categories` and
`pageContexts` arrays.

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

Scanner policy and rule-pack provenance are runtime snapshots. Mutating the source options object,
rule-pack metadata, rule arrays, rule metadata, or built-in pack export after scanner creation does
not change future scan results. Public `Rule`, `RuleMeta`, and `RuleOverride` TypeScript contracts
also expose these fields as immutable.

This package exposes deterministic findings only. It does not perform network reputation checks,
AI review, scoring, baselines, suppressions, or automatic fixes.

Purchase Guard-style products should stay separate from FairUX. They may reuse this SDK and
RulePack composition for UX signals, but URL, TLS, domain, redirect, reputation, and other
site/security checks belong in separate application-layer reports.

## Trust boundary

The FairUX engine and built-in rule pack are local-only, make no network requests, make no AI calls,
and are deterministic for the same normalized input.

Third-party rule packs are different: a rule pack's `evaluate()` function is ordinary JavaScript.
It is not sandboxed by FairUX and may use network access, filesystem access, mutable state, or AI
APIs if the environment allows it. Treat third-party packs as trusted executable dependencies:
pin package versions, review source, keep lockfile integrity, and do not dynamically download
unknown remote packs or inject arbitrary pack code into a browser extension.

For remote HTML or URL checker workflows, pass size-bounded HTML into `scanHtml()` from an isolated
process or worker. Do not expand remote content into arbitrary local file trees and treat FairUX or
the CLI as a filesystem sandbox.
