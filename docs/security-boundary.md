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

## What runs where

| Surface | Runs | Network |
| --- | --- | --- |
| CLI | Locally, on files you name | None during a scan |
| Chrome extension | In the page, locally | None |
| SDK | In your process | None, unless you pass an AI provider |
| Publish workflows | GitHub Actions, privileged job only | npm, to publish |

The extension reads the page it is on and reports locally. The HTML report is a single self-contained
file with no script and no remote reference, so opening one makes no request and cannot report back
on what was scanned.

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
