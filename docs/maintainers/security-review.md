# Third-party security review

What an independent reviewer needs to start, what this project would like them to look at, and what
happens to what they find.

> [Criterion `S6`](release-criteria.md#platform-and-supply-chain) is a review that has actually
> happened. This page is preparation for one and is not evidence that one occurred; it stays open
> until a reviewer outside this repository has done the work and their findings have been dispositioned.

## Start here

```bash
pnpm install
pnpm verify:full        # everything CI runs, plus both package smokes, offline
pnpm review:evidence    # the tree's non-secret facts at this commit, as JSON
```

`pnpm review:evidence` prints the commit under review, the published versions and what their
tarballs contain, the lockfile digest, every workflow with its triggers and permissions, every
action and the commit it is pinned to, and the exact steps `verify:full` runs. Everything in it is
read from the tree — nothing on this page restates it, because a packet that restated an inventory
would be wrong the first time the inventory changed.

The threat model is not rewritten here either. It is
[the security boundary](../reference/security-boundary.md), with the reporting policy and the
explicit out-of-scope list in [SECURITY.md](../../SECURITY.md). Read those first; this page assumes
them.

## What is in scope

Ordered by what this project would lose most if it were wrong.

**Parsers on untrusted input.** Every scanned page, JSX/TSX source, and Figma export is somebody
else's data. `@fairux/html` wraps parse5, `@fairux/ast` wraps the TypeScript compiler, `@fairux/figma`
parses JSON this project wrote the reader for. Unbounded recursion, quadratic behaviour, memory
growth on adversarial input, and anything that escapes the document into the process.

**Rule patterns.** Catastrophic backtracking in dictionary entries. They are meant to be literal or
anchored, and never carry `/g` or `/y`; tests assert the flags, which is a weaker claim than "these
cannot backtrack".

**The rendered surfaces, which carry attacker-controlled text verbatim.** The self-contained HTML
report is the one a reviewer opens in a browser. Escaping is the only path a value takes there. A
rule id from a third-party pack reaches every surface too.

**The write path.** `--fix-write` rewrites files in place; `--write-baseline` and `--risk-index`
create files. What stops an output from being an input is path identity by inode, staged as each
path becomes knowable. Look for a spelling of "the same file" the comparison does not see, and for a
window between the checksum and the write.

**The trust model, and whether the boundary is where the documents say.** A RulePack and an
executable config are unsandboxed JavaScript running with the user's privileges, deliberately and
loudly. What matters is whether anything *else* can reach that privilege: auto-discovery of an
executable config, a pack loaded from a config key, a path a manifest supplies that escapes its
package.

**Baselines, suppressions, and filter provenance.** These subtract findings. A suppression that
applies more broadly than its entry claims, an expiry that does not expire, or a digest that does
not identify the file that ran are all ways a build goes green while the finding is still there.

**The extension host boundaries.** The Chrome extension injects a scanner into one tab on a click
and asks for `activeTab` + `scripting`; the VS Code extension runs in the extension host. Message
passing, `web_accessible_resources`, and anything a page could send back.

**The release path.** Trusted Publishing with OIDC in a privileged job no other job can reach,
tarballs re-downloaded and hashed rather than trusted from the upload, and every action pinned by
commit. `pnpm review:evidence` prints the permission surface of every job.

**The holdout and corpus evaluators**, which read manifests prepared outside this repository and open
the files those manifests name.

## What is out of scope

Not because it is uninteresting, but because a finding there is not a finding about this project:

- **A third-party RulePack doing something hostile.** It is trusted, unsandboxed code by design, said
  in three documents and in a warning printed before every load. "A pack can read your filesystem" is
  the documented model, not a vulnerability.
- **What a scanned page can do to itself.** FairUX reads pages; it does not execute them.
- **The absence of a `network` capability.** Refused as a product decision, with reasons.
- **Detection quality.** Whether a rule is right is [`P7`](release-criteria.md#product), and it has
  its own harness.
- **npm, GitHub, and the registry** as infrastructure — though how this repository *uses* them is
  firmly in scope.

## What we are asking for

A written report, per finding:

- what an attacker controls, and what they get;
- the path from one to the other, reproducible against a named commit;
- severity, argued rather than asserted;
- whether the documents already claim the property that broke — a boundary that was never claimed is
  a feature request, and one that was claimed and does not hold is the finding this review is for.

A finding of "nothing here" against a named area is worth writing down too. It is the only thing that
makes the next review's scope decisions cheaper.

## Triage and closure

1. **Report privately.** [SECURITY.md](../../SECURITY.md) is the channel: a GitHub security advisory,
   not an issue. That holds during a commissioned review as well.
2. **Reproduce, at a commit.** A finding this repository cannot reproduce is not dismissed; it is
   discussed, with what was tried recorded.
3. **Fix, with a test that fails without the fix.** This is the repository's standing bar and it is
   not lowered for a review finding. A fix whose test would pass on the unfixed tree has closed
   nothing.
4. **Disclose.** Advisory, changelog entry, and a release if a published package is affected.
5. **Disposition every finding**, including the ones not fixed. "Accepted, because the trust model
   already says so" is a valid disposition and has to be written down as one; a finding that quietly
   goes unanswered is the failure mode of a review report.

## What closes `S6`

The review having been performed by somebody who did not build this, and every finding
dispositioned — fixed, or accepted in writing with the reason. Recorded the way this repository
records evidence: the reviewer, the commit reviewed, the report, and the disposition of each finding.

Not this page. Not `pnpm review:evidence`. Not a clean internal audit, which is what the security
boundary already says a reader should discount.
