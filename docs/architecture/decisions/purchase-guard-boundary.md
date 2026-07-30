---
id: purchase-guard-boundary
legacy_id: P18-T1
title: "Purchase Guard architecture boundary"
status: accepted
date: 2026-07-30
---

# Purchase Guard architecture boundary

## Context

Three documents already say that a Purchase Guard-style product is separate from FairUX and that
URL, TLS, domain, redirect, and reputation signals belong in an application-layer namespace: the
root README, the SDK README, and `docs/status.md`. None of them is checkable, and the mechanism they
describe is already load-bearing — `tests/fixtures/sdk-custom-rule-pack/valid/purchase-guard-pack.mjs`
composes a `purchase-guard/` namespace against the built-in pack today.

A boundary stated three times in prose and enforced nowhere is the weakest artifact in a repository
that gates build output, runtime safety, rule review, and release eligibility. It fails quietly and
in the direction that feels helpful: the first time a site-security signal would be *convenient* to
express as a FairUX finding, nothing refuses it, and the product boundary is gone before anyone
notices it moved.

This record restates the boundary as a small set of conditions a test can read, and pins them. It adds
no runtime code. Registry-installed proof and real Purchase Guard pack execution are follow-up work.

## Decision

FairUX supplies **UX risk signals about a normalized UI**. Everything about the *site* — its
identity, its transport, where it sends the user, and what others say about it — stays in the
consuming application's own namespace, in its own field, under its own vocabulary.

### 1. FairUX findings carry no site or security signal

No built-in rule id, category, page context, or tag may use site/security vocabulary. The reserved
terms are the whole of this block, one per line — the test parses it, so it is data rather than
prose, and no surrounding sentence can add to it or subtract from it:

```text
security
url
uri
tls
ssl
https
certificate
domain
hostname
dns
whois
redirect
reputation
blocklist
blacklist
allowlist
phishing
malware
scam
fraud
spoof
typosquat
homograph
ip-address
geoip
virustotal
safe-browsing
```

`security` is on that list because the rule this record states is that FairUX must not grow a
`security` category. An earlier draft explained exactly that and then omitted the word, so
`purchase-guard/security` and `site-security` passed the check the sentence described.

A term is matched as a **contiguous run of identifier segments**, so `ip-address-risk` and
`safe-browsing-check` are caught while `hidden-cost` and `checkout` are not. A term written with a
hyphen is only meaningful if the matcher treats it as one term; the first version of this contract
listed `ip-address` and `safe-browsing` beside a single-segment matcher that could never have
matched either, which made two of its own reserved terms decorative.

**camelCase and acronym boundaries are segments.** Rule ids, categories, and page contexts are
slugs, but `tags` is an arbitrary string, so `domainReputation`, `safeBrowsing`, and `TLSCheck` are
the realistic evasion — lowercasing before splitting turned each into one unsplittable segment.

This rule binds two surfaces, and it is worth separating them because FairUX governs them
differently:

- **The built-in pack** — FairUX's own product surface. What the rule prevents is FairUX growing a
  `security` category and quietly becoming a site checker.
- **This repository's Purchase Guard reference pack**
  (`tests/fixtures/sdk-custom-rule-pack/valid/purchase-guard-pack.mjs`) — the example an external
  author copies. It ships under FairUX's name, so it is held to this record.

FairUX **cannot** semantically govern arbitrary third-party RulePacks: they are trusted executable
JavaScript outside the built-in product surface, and the extensible taxonomy in
[The extensible taxonomy contract](extensible-taxonomy-contract.md) exists precisely so that they can name what they
measure. That technical freedom is not a licence, and it does not make every third-party pack
conform to this architecture. A Purchase Guard-style RulePack that *follows this record* emits only UX,
content, form, and interaction signals derived from normalized UI input. `purchase-guard/bad-tls`,
`purchase-guard/domain-reputation`, and `purchase-guard/phishing-check` are technically valid
RulePack IDs and are non-conformant: a namespace prefix changes who owns the identifier, not which
field the signal belongs in. Site and security signals stay in `siteSignals`.

### 2. The consumer contract is three entry points

The consumer **runtime API is three entry points**: `@fairux/sdk`, `@fairux/sdk/html`, and
`@fairux/sdk/dom`. Nothing else is a runtime import.

`@fairux/sdk/package.json` is a **metadata-only export**, for reading the installed version or
checking package integrity. It is permitted and it is not a fourth runtime API; every consumer
fixture that reads it does so to assert what it installed.

The rule is stated as an allowlist of those three, not as a denylist of the rest. Every other
workspace package is implementation detail: `@fairux/core`, `@fairux/rules`, `@fairux/html`,
`@fairux/dom`, `@fairux/ast`, `@fairux/report`, `@fairux/figma`, `@fairux/config-node`,
`@fairux/chrome-extension`, and the unscoped `fairux` and `fairux-vscode` — and so is any package
added after this sentence was written. The forbidden set is **derived from the workspace manifests**
for exactly that reason: an enumeration would have been an allowlist of everything it forgot, and the
first version of this contract's test forgot three packages that already existed.

A deep import into `packages/*/src`, a `workspace:` specifier, or a relative path into this monorepo
is not an integration either; it is a fork with extra steps.

### 3. Site signals live beside the report, never inside it

A Purchase Guard-style application composes, rather than merges:

```ts
import type { FairUxReport } from "@fairux/sdk";

/** Whatever the application measures about the site. FairUX defines none of this. */
interface SiteSignals {
  readonly url: string;
  readonly tlsValid: boolean;
  readonly redirectChain: readonly string[];
  readonly domainReputation: "unknown" | "known-good" | "known-bad";
}

/** The application's report. Two fields, two owners, two vocabularies. */
interface PurchaseGuardReport {
  /** Produced by FairUX. Never edited, never appended to. */
  readonly fairux: FairUxReport;
  /** Produced by the application. Never expressed as a FairUX finding. */
  readonly siteSignals: SiteSignals;
}
```

`FairUxReport.findings` is FairUX's output and the application does not write into it. The
application's own conclusions — including any combined verdict — belong to `PurchaseGuardReport`,
not to a finding.

The direction that matters is the one that is tempting: it is easy to add
`{ category: "security/bad-tls" }` to `findings` and get SARIF, severity, and CLI rendering for
free. That convenience is exactly what this contract refuses. The application pays for its own
rendering, or wraps FairUX's.

### 4. FairUX returns no verdict about fraud, legality, or safety

A FairUX report is evidence for a human decision. It is not a determination that a page is
fraudulent, lawful, unlawful, safe, or unsafe. Those are the consuming product's conclusions to
draw and to be accountable for.

### 5. Zero findings is not a clean bill of health

An empty `findings` array means the enabled rules found nothing they can detect on the input they
were given. It does not mean the page is fair, safe, or legal. No FairUX surface, and no document
describing one, may present zero findings as a pass, a clean result, or a safety verdict.

This is the same failure mode as an empty log reading as a clean scan: absence of a signal is not
evidence of absence, and a product that renders it as a green check has made a claim FairUX did
not.

### 6. Purchase Guard is a product, not a mode

There is no FairUX flag, option, preset, or entry point that turns FairUX into Purchase Guard.
Composition happens in the consuming application, through the public RulePack contract.

## Validation

`tests/unit/external-consumer-boundary.test.ts` reads the real artifacts rather than a checked-in
copy of them. Precisely, it asserts over:

| Artifact | What is asserted |
| --- | --- |
| `docs/generated/rule-catalog.json` | built-in rule ids, categories, tags, and page contexts carry no reserved term |
| `tests/fixtures/sdk-custom-rule-pack/valid/purchase-guard-pack.mjs` | the reference pack's taxonomy and rule identifiers carry no reserved term |
| `packages/sdk/package.json` | the `exports` map is exactly the three entry points plus `./package.json` |
| `packages/*/package.json`, `apps/*/package.json` | the forbidden package set, derived rather than enumerated |
| every governed fixture tree | static imports resolved through Node's parser, under the package policy and the path policy; complete raw quoted literals under the package policy, and path-shaped ones in type-stripped sources under the path policy; the broader `@fairux/…` matcher over prose and comments; relative imports confined to the fixture tree and resolving to a governed source; no direct `import(` or `require(`; no absolute or `file:` specifier; no symlink; no JSX |
| fixture `package.json` files | no workspace package but `@fairux/sdk`; no `workspace:`, `catalog:`, `file:`, `link:`, `portal:`, `patch:`, `npm:`, or `git+file:` range; no path range including `~/` and `~\`; and no `imports`, `overrides`, `resolutions`, `packageExtensions`, `pnpm.overrides`, `pnpm.patchedDependencies`, or `pnpm.packageExtensions` |
| the public READMEs and `docs/status.md` | the entry points, the no-verdict refusal, and Purchase Guard's separateness are still stated where a user reads them |
| this record | the reserved vocabulary, the typed envelope, and the scope limits below |

The reserved vocabulary is parsed out of the list above, so a term added to this contract is
enforced without editing the test, and a term removed stops being enforced visibly.

Three properties of that test are themselves easy to overclaim, so they are pinned:

- The catalog is a **projection** of the runtime pack, not the pack itself; `pnpm
  rules:catalog:check` fails in CI when the two disagree, which is what makes reading it equivalent
  to reading the pack.
- The vocabulary matcher is tested **in both directions**. `security/bad-tls`, `domain-reputation`,
  `phishing`, `url`, `ip-address-risk`, and `safe-browsing-check` must be rejected, while
  `hidden-cost`, `consent/bundled-consent`, `checkout`, and `obstruction` must not be. A matcher
  that has only ever seen passing input proves nothing about what it would catch.
- Imports are read with a **parser, not a substring search**. `staticImportSpecifiers` asks Node's
  own module parser, and TypeScript fixtures are type-stripped by `node:module` first, so quote
  style, subpath, and `export … from` cannot evade it.

  That parser has stated limits, and each has its own rule rather than a footnote. Type stripping
  **erases type-only imports**, so `import type … from "@fairux/chrome-extension"` leaves nothing
  behind. Dynamic `import()` and `require()` are not static module requests, so the fixtures may not
  use them at all. Node's stripping does not handle **JSX**: a `.tsx` or `.jsx` fixture fails the
  contract rather than being skipped, and a **parse failure throws** — a fixture this cannot read
  must not be reported as clean.

  There is exactly one authority per artifact, and it is worth stating once rather than in the three
  overlapping ways earlier revisions did:

  | Artifact | Authority |
  | --- | --- |
  | a parsed static specifier | the exact package policy **and** the path policy |
  | a complete raw quoted literal | the same exact package policy |
  | a **path-shaped** raw quoted literal in a type-stripped source | the path policy |
  | prose and comments | the broader `@fairux/…` textual matcher, supplementary |
  | any escaped quoted literal | prohibited outright |

  The third row is the one the first five revisions missed. Type stripping erases a type-only
  import *and its specifier*, so `import type { X } from "../../../packages/core/src/index.ts"`
  reached no parser — and the raw-literal rule that covers erased *package* imports checked package
  names only, not paths. In `.ts`, `.mts`, and `.cts` fixtures every complete raw quoted literal
  that looks like a path — relative, absolute, or a `file:` URL — is therefore held to the path
  policy as well.

  That deliberately rejects a path-shaped *data* string in governed TypeScript fixture source.
  Telling a data string apart from an erased module specifier is a TypeScript module-specifier
  lexer, and this contract has spent enough revisions establishing that a hand-rolled lexer is the
  more expensive mistake.

  **Parsed static specifiers and raw quoted literals share one exact-match policy**, scoped and
  unscoped alike. Two earlier splits both leaked through the seam: checking `@fairux/…` at the
  parser and unscoped names only in raw text let `import "fairux"` decode to `fairux` for the
  parser, which was not looking, and stay encoded for the text rule, which could not see it; and
  matching the `@fairux/…` *shape* rather than the whole literal let `"@fairux/sdk/html?internal"`
  match as far as an allowed entry point and stop. The textual matcher over-flags by design — in a
  consumer example, a mention of an internal package is a finding whether or not it is an import.

  **Escaped quoted literals are prohibited** in governed fixture
  source, including line continuations: `"@fairux/core"` is the same specifier as its plain
  spelling, a type-only import is erased before any parser produces a decoded form, and decoding
  here would mean implementing a string-literal grammar. **Relative
  imports must name an explicit supported extension** — `.js`, `.mjs`, `.cjs`, `.ts`, `.mts`,
  `.cts`, or `.json` — because extensionless and directory resolution differ between Node,
  TypeScript, and bundlers, and re-implementing three algorithms to decide what a path means is how
  a checker becomes the thing it is checking. `../package-boundary/package-b/src/index` reached the
  one excluded tree precisely through that gap.

  The `file:` URL scheme is matched **case-insensitively**: `FILE:`, `File:`, and every other
  ASCII-case spelling are the same prohibited scheme, because URL schemes are case-insensitive and
  `new URL("FILE:///tmp/x")` reports `protocol: "file:"`.

  Between two tokens, **a comment is whitespace**: `import /* c */ ("x")` is the same dynamic load
  as `import("x")`, and the detection consumes block and line comments rather than spaces alone.

**Fixture trees are discovered, not listed.** Every directory under `tests/fixtures` is governed
except an explicit, reason-bearing exclusion, and a stale exclusion — one naming a directory that no
longer exists — fails, because the next tree to take that name would inherit the exemption. Today
the only exclusion is `package-boundary`, a TypeScript `rootDir` fixture that is not an SDK consumer.

A **top-level symlink is rejected from the same read** that finds the roots. A symlink to a
directory is not a directory entry, so filtering on that alone dropped `tests/fixtures/x ->
../../packages/core` out of the roots, out of the file walk, and out of the symlink check further
down, which only ever looked inside trees it had already found. One read, symlinks taken first.

An earlier version listed four roots, which was wrong twice: a fixture added by the follow-up would not
have been checked at all, and `sdk-custom-rule-pack/invalid` was ungoverned while
`sdk-node-consumer/governance-consumer.mjs` imports three files out of it. A governed file reaching
into an ungoverned tree is a hole with one hop in it, so relative source imports are additionally
required to resolve to a source this contract inspects.

The dependency rules name **local sources** — the protocols and path shapes that resolve to
something in this working tree rather than to a published package. `git+file:` and a `~/` home-relative
path are on that list because npm accepts both, and `catalog:` because it reads its range from the
workspace's own `pnpm-workspace.yaml`. Remote Git, GitHub shorthand, and remote tarballs are *not*
banned here: they are not local, and whether an install actually came from the public registry is a
runtime fact. That is fixed by the follow-up's install proof, not by reading a manifest.

A range is only half a manifest. `overrides`, `resolutions`, `packageExtensions`, `pnpm.overrides`,
`pnpm.patchedDependencies`, `pnpm.packageExtensions`, and Node's own `imports` map can each
substitute a different package for the one a dependency names — a clean
`"@fairux/sdk": "0.1.0-beta.2"` beside an override to `link:../../../packages/sdk` installs the
workspace copy. **These fields are refused outright in a governed fixture manifest** rather than
interpreted. Each has its own resolver semantics across npm, pnpm, and Yarn, and re-implementing
three resolvers to decide what a manifest means is the same mistake as re-implementing three module
resolution algorithms. A consumer fixture has no need for any of them.

Dynamic loading is refused as **direct syntax**: a literal `import(` or `require(` call, with every
ECMAScript LineTerminator — LF, CR, CRLF, U+2028, U+2029 — recognised as ending a line comment
between the tokens. The contract performs **no data-flow analysis**: `const load = require; load(…)`,
`globalThis["require"](…)`, and `createRequire(…)` are not tracked, and this record does not claim they
are. What actually executes under a real install is the follow-up's evidence.

What the test does **not** establish: that an external consumer can install from the registry and
run a composed pack. That is follow-up work, and no assertion here may be read as covering it.

## Consequences

- A new built-in rule that needs site vocabulary fails a test rather than a review. If FairUX ever
  should own such a signal, this record is what gets amended — deliberately, with the boundary moving
  on the record instead of by omission.
- Arbitrary third-party packs remain outside FairUX governance, by construction rather than by
  choice. Nothing here constrains what someone else's pack measures or how it names things.
- This repository's Purchase Guard reference fixture *is* governed by this record, and must keep
  site/security vocabulary out of its RulePack metadata. It is the example an external author
  copies; an example that violated the contract would teach the violation.
- Documents keep saying what they said; they now say it in one authoritative place, with the other
  three pointing at it.
- The contract is structural, not behavioral: it reads identifiers, exports, and prose. It cannot
  detect a rule that *implements* a network check while naming itself something innocuous.
  `pnpm check:runtime-safety` and the SDK's browser-module audit cover that from the other side, and
  neither is claimed here.
