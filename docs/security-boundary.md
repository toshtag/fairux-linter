# Security boundary

What FairUX trusts, what it does not, and what it will not do even when asked.

Most of this is enforced somewhere already. None of it was in one place, which meant a reader had to
assemble it from six documents and a test file.

For reporting a vulnerability, see [SECURITY.md](../SECURITY.md).

## What is untrusted

**Everything in a scanned page.** Text, attributes, and markup are input from somebody else, and the
report carries them verbatim. The consequence lands hardest on the HTML report, which a reviewer
opens in a browser: escaping there is the only path a value can take, all five characters are
escaped rather than the usual three, and the tests parse the output with real breakout payloads
rather than matching substrings — because `&quot; onmouseover=&quot;x` contains the substring
` onmouseover=` while being completely inert.

**A rule id from an external pack**, for the same reason: it reaches every rendered surface.

## What is trusted, and stated rather than implied

**A third-party RulePack is executable JavaScript that FairUX does not sandbox.** It runs with the
privileges of whoever ran the scan, and it can read the filesystem — the remediation fixture in this
repository does exactly that. Loading one is explicit per invocation (`--rule-pack`), with no
auto-discovery and no config key, because a discovered pack would make cloning a repository enough to
run its code. The CLI prints a warning naming the pack every time one is loaded.

**An executable config** (`fairux.config.ts` and friends) is the same. Auto-discovery loads
`fairux.config.json` only; anything executable must be named on the command line.

## What FairUX will not do

- **Return a verdict.** Not legal, not fraud, not site safety, not "this page is fair". Findings are
  risk signals for review, and no output — including the Risk Index — is a compliance statement.
- **Ship a rule change nobody reviewed.** `rule-review-baseline.json` records a digest of what the
  built rules match with and what they do to a frozen probe set, so editing a pattern — or the guard
  inside an `evaluate` body — fails CI whether or not the rule's version was bumped. See
  [rule review](rule-review-workflow.md#the-detection-digest-and-the-hole-it-closes).
- **Classify by site or security vocabulary.** URL, TLS, domain, redirect, and reputation signals
  belong to Purchase Guard-style products at the application layer, not inside a FairUX finding.
  Enforced by `tests/unit/external-consumer-boundary.test.ts`.
- **Auto-apply an AI-suggested edit.** An `ai`-origin remediation cannot be marked `safe`, refused in
  validation rather than promised in a document.
- **Let an AI signal fail a build.** `--fail-on` reads findings. A report whose only signal is an AI
  observation exits 0 at every threshold.
- **Send anything that was not on an allowlist.** The AI payload is assembled from normalized text,
  tag names, and detected page contexts — no attributes, no file paths — and a field added to the
  model does not appear until someone adds it to the allowlist.
- **Call the network from the engine.** `@fairux/core` and `@fairux/rules` contain no `fetch`, no
  socket, and no provider; a test asserts it.
- **Watch the requests a page makes.** The `network` capability is decided, not merely unbuilt — see
  below.

## The `network` capability, and why it stays unavailable

`network` is the last capability in the vocabulary that nothing supplies, and it is the only one that
is unsupplied by **decision** rather than by not having been built yet. Four things had to be settled
before any code, and they are settled here
([issue #126](https://github.com/toshtag/fairux-linter/issues/126)).

**The extension permission is refused.** Observing requests means `webRequest` or the debugger API.
`declarativeNetRequest` is not one of the options: it blocks, redirects, and rewrites headers through
declarative rules precisely so that an extension never reads the requests it acts on, which is the
opposite of what an observation would need.

It is **not** true that this is technically impossible today. `activeTab` plus `webRequest` can
observe requests from the current tab to its main-frame origin, temporarily, after the user invokes
the extension. What it cannot reach is the part that matters: cross-origin iframes — where a consent
frame's requests live — third-party subresources, and redirects all need host access to both the
request's origin and its initiator, which is beyond what `activeTab` grants. Comprehensive
observation therefore needs standing host access that the current design does not have.

So the refusal is not "it cannot be done". It is that the permission, the data it would collect, and
the privacy model that comes with it do not fit this product. The extension holds `activeTab` and
`scripting`, runs no content script, and touches a page only when you click **Scan this page**;
standing access to every page's traffic is not a bigger version of that.
`apps/chrome-extension/test/manifest.test.ts` fails if the manifest grows any of those permissions.

**Nothing about a request would leave the machine, and most of it would never be recorded.** If this
is ever built under some other design, these bind it: observations stay local, the coarsest useful
unit is the registrable domain — no paths, no query strings, no headers, no bodies — and nothing is
written to a report by default. A request list is a list of third-party domains a person visited, and
that is a different category of data from "this checkbox was pre-checked".

**Network observations would never sit inside a finding's evidence.** Evidence travels into SARIF and
from there into GitHub code scanning, which has its own retention, its own audience, and its own
export paths. A third-party domain arriving there is a disclosure nobody chose. Any future shape puts
network observations in their own block, the way an AI observation already sits outside `findings`.

**The Purchase Guard line stays where it is.** URL, TLS, domain, redirect, and reputation signals
belong to application-layer products, not inside a FairUX finding — already enforced on rule
identifiers by `tests/unit/external-consumer-boundary.test.ts`. A `network` capability would sit close
to that line, so the rule for it is explicit: it may only back a claim about the **interface** — that
a consent banner sent something before the user chose — never a claim about the **destination**, how
trustworthy it is, or where it resolves.

**So every scan reports `network` as unavailable**, and a rule requiring it is skipped and says so.
That is the accurate answer and not a placeholder. Resource timing — the API reachable from a content
script, and the one that looks like it would do the job — collapses redirects into a single entry, may
omit cache hits entirely, cannot see inside cross-origin iframes, is answered by service workers
before it reaches the network, exposes no request bodies, and attributes initiators too coarsely to
point at a cause. A capability that claimed to observe the network and answered none of those would be
worse than one reported as missing.

**No optional permission is left as a door.** `optional_permissions` would make this a prompt a user
sees rather than a decision this project made, and the decision is the point. Reconsidering it later
is a separate issue and a separate product judgement — a distinct extension or an explicit opt-in
design — and local-only storage, the granularity, a retention period, the report schema, and how
consent is obtained are all settled before any of it is written, exactly as they were here.

## What runs where

| Surface | Runs | Network |
| --- | --- | --- |
| CLI | Locally, on files you name | None during a scan |
| Chrome extension | In the page, locally | None |
| SDK | In your process | None, unless you pass an AI provider |
| Publish workflows | GitHub Actions, privileged job only | npm, to publish |

The extension reads the page it is on and reports locally — the page's own DOM, and not its traffic.
The HTML report is a single self-contained file with no script and no remote reference, so opening one
makes no request and cannot report back on what was scanned.

## Writing to files

`--fix-write` is the only thing that writes, and only to paths that came from the scan it just ran.
It applies `safe` remediations and nothing else; there is no `--unsafe`, `--force`, or `--yes`. Every
edit states the text it expects to replace, a checksum pins the bytes the edits were computed
against, and a remediation whose edits do not all resolve applies none of them.

## Supply chain

Every workflow action is pinned by full commit SHA. Publication uses npm Trusted Publishing with
OIDC, in a privileged job that no other job can reach, and the published tarball is re-downloaded and
hashed against what the run audited rather than trusted from the upload. Provenance is read back from
the registry rather than assumed.

## What this page does not claim

FairUX has not had a third-party security review. The boundaries above are enforced by tests in this
repository, which is a different and weaker thing than having been attacked by someone competent.
