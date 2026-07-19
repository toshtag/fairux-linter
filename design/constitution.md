# Project Constitution

Principles guiding all planning and implementation for FairUX Linter.

## Core principles

- Keep @fairux/core and @fairux/rules runtime-agnostic and browser-safe: no Node, DOM, or parser dependencies.
- Treat the FairUxReport JSON output as a public API: additive changes only; bump schemaVersion for anything breaking.
- Prefer conservative, explainable findings over noisy detection; reducing false positives is a primary quality goal.
- Detect UX risk signals, not intent. Avoid legal or moralizing language such as illegal, malicious, or fraud.
- Keep AI out of the core. AI-assisted explanations are out of scope for the current public roadmap.
- Resist scope expansion: strengthen evidence, fixtures, and contracts before adding new product surfaces.
- License posture is undecided and must be clarified before broader reuse or distribution.
