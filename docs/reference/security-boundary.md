# Security boundary

What FairUX guarantees, what it trusts, what it does not, and what it will not do even when asked.

Most of this is enforced somewhere already. None of it was in one place, which meant a reader had to
assemble it from six documents and a test file.

For reporting a vulnerability, see [SECURITY.md](../../SECURITY.md).

## What FairUX guarantees

With the built-in RulePack, and for the same normalized input under the same scanner policy, FairUX
returns deterministic findings carrying evidence, severity, confidence, rule identity, an explanation
of why the issue matters, and a human-readable recommendation. Locale, enabled packs, experimental
rules, and rule or severity overrides are all part of that policy.

Rule governance metadata and known limitations live on the RulePack rather than in `FairUxReport`.
Third-party RulePacks are trusted executable JavaScript and are **outside that determinism
guarantee** — a pack's `evaluate()` may use mutable state, the clock, or a network call.

FairUX does not return legal verdicts, fraud verdicts, site safety verdicts, or proof that a UI is
fair. Purchase Guard-style products are separate applications: they may reuse the SDK and the
RulePack contract, but URL, TLS, domain, redirect, and reputation signals belong in their own
namespace at the application layer, never inside a FairUX finding.

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
- **Let a rule change pass pull-request CI without a matching review baseline.**
  `rule-review-baseline.json` records a digest of what the built rules match with and what they do
  to a frozen probe set, so editing a pattern — or the guard inside an `evaluate` body — fails
  `rules:reviews:check` whether or not the rule's version was bumped. The regenerated baseline then
  has to arrive in the same diff, which is what makes the change visible on the pull request.

  That is the extent of it. It does not establish that a person reviewed the change — there is no
  approval event and no required reviewer, by
  [a decision recorded in the rule review runbook](../maintainers/rule-review.md#the-detection-digest-and-the-hole-it-closes)
  — and it does not itself prevent a direct push where repository settings permit one.
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

`network` is the last capability in the vocabulary that nothing supplies, and the only one that is
unsupplied by **decision** rather than by not having been built yet. Four things were settled before
any code ([issue #126](https://github.com/toshtag/fairux-linter/issues/126)).

**Every scan reports `network` as unavailable**, and a rule requiring it is skipped and says so.
That is the accurate answer, not a placeholder.

**The extension permission is refused.** Observing requests means `webRequest` or the debugger API —
`declarativeNetRequest` is not an option, since it acts on requests through declarative rules
precisely so that an extension never reads them. This is not that it is technically impossible:
`activeTab` plus `webRequest` can see the current tab's main-frame requests, but cross-origin
iframes, third-party subresources, and redirects all need standing host access, which the extension
does not have and will not ask for. **No optional permission is left as a door** either;
`optional_permissions` would turn a decision this project made into a prompt a user sees.
`apps/chrome-extension/test/manifest.test.ts` fails if the manifest grows any of them.

**Network observations would never sit inside a finding's evidence.** Evidence travels into SARIF
and from there into GitHub code scanning, with its own retention, audience, and export paths. A
third-party domain arriving there is a disclosure nobody chose.

**Anything built later starts from these.** Observations stay local; the coarsest useful unit is the
registrable domain — no paths, query strings, headers, or bodies; nothing is written to a report by
default; and consent is explicit. A request list is a list of third-party domains a person visited,
which is a different category of data from "this checkbox was pre-checked".

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

These flags write, and nothing else does. `--write-baseline` and `--risk-index` create files this
tool owns, at paths the caller named. `--fix-write` rewrites a file you are editing, and only at
paths that came from the scan it just ran.

`--fix-write` applies `safe` remediations and nothing else; there is no `--unsafe`, `--force`, or
`--yes`. Every edit states the text it expects to replace, a checksum pins the bytes the edits were
computed against, and a remediation whose edits do not all resolve applies none of them.

No output may be a file the run reads. Every write path is compared against every scanned file, the
config, the suppressions file, the baseline, the ignore file, every rule pack, and every other
output — by inode where both exist, so a relative path, a symlink, and a hard link are all seen as
the same file.

The comparison runs as each path becomes known: the flags first, then the discovered config and
ignore file, then the scanned files once a directory or glob has been expanded. Every read and write
path is compared before any output is written, and rule packs are loaded only after the last of
those checks. An explicitly named executable config is loaded earlier, because the scan needs it —
it is trusted code the CLI warns about before running, and running it is not a write. A collision is
a usage error, and the run stops having written nothing.

### How each is written

`--write-baseline` and `--risk-index` create files this tool owns. Those are written to a temporary
file in the same directory and renamed into place, so an interrupted write cannot leave a truncated
file where a valid one was. A path you named as an output is replaced, as with any other tool.

`--fix-write` rewrites a file you are editing, and opens that file rather than replacing it. The
inode does not change, so nothing attached to it does either: the mode, the owner, ACLs, extended
attributes, the symlink pointing at it, the other hard links, and — on Windows — the security
descriptor. This is how `prettier --write` and `eslint --fix` write, and it is available on every
supported platform.

The file is opened first and its checksum verified through that same open file, so the bytes that
are checked and the bytes that are replaced are the same file — an editor saving atomically between
a read and an open would otherwise have its new file truncated on the strength of the old one.

The trade is that the risky window is inside the file rather than beside it. A write that fails
partway leaves the file short, so the original bytes are held and written back; if that restore also
fails, the run says so in as many words.

What is *not* guaranteed: several files are not a transaction — a refusal partway leaves some
written and some not, and the run says which. Nothing here survives a power loss; no formatter's
in-place write does.

A change the checksum or the path-identity check observes is refused, never merged. Those checks run
immediately before the write and again after it, which is as close as a lock-free write gets: FairUX
holds no cross-process lock and does not claim to exclude every concurrent write.


None of this is a defence against the code this tool is told to run. A RulePack and an executable
config are trusted, unsandboxed JavaScript running with your privileges — the CLI says so before
loading either. Code that wanted to damage your tree would not need to go through any of the
writers above.

## Supply chain

Every workflow action is pinned by full commit SHA. Publication uses npm Trusted Publishing with
OIDC, in a privileged job that no other job can reach, and the published tarball is re-downloaded and
hashed against what the run audited rather than trusted from the upload. Provenance is read back from
the registry rather than assumed.

## What this page does not claim

FairUX has not had a third-party security review. The boundaries above are enforced by tests in this
repository, which is a different and weaker thing than having been attacked by someone competent.
