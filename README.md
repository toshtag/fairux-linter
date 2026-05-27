# FairUX Linter

> Dark pattern linter for modern product teams.
> Detect UI patterns that may distort user decision-making — before release.

FairUX Linter is a **rule-based, explainable** linter that flags UI patterns which may
distort informed user decision-making (dark patterns / misleading subscription flows /
hidden costs / unfair consent UI / cancellation friction / scarcity pressure).

It is built around a runtime-agnostic core (`@fairux/core`) so the same rules can later run
across multiple surfaces (CLI, Chrome extension, VS Code extension, CI, Figma).

## ⚠️ Disclaimer

FairUX **does not provide legal judgments** and does not determine whether a UI is "illegal"
or "malicious". Findings are **UX risk signals** intended for human review.

## Status

**v0 — in active development.** Scope: `@fairux/core` + `@fairux/rules` + `@fairux/html`
+ `@fairux/report` + a `fairux` CLI that scans static HTML and reports findings as JSON / Markdown.

```bash
# (coming in v0)
fairux scan ./path/to/page.html --format json
fairux scan ./path/to/page.html --format markdown
```

## License

Not yet licensed (`UNLICENSED`). A license model will be decided before any public release.
