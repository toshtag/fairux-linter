---
id: P12-T1
title: "Public SDK facade"
status: accepted
date: 2026-07-15
---

# ADR P12-T1: Public SDK Facade

## Context

FairUX already shares the same deterministic rule engine across the CLI, Chrome extension, VS Code
extension, and adapters. That proves the internal architecture, but it does not give external
products a stable contract. A consumer such as Purchase Guard should not depend on monorepo-private
package layout, internal registries, or low-level adapter implementation details.

The hard boundary is compatibility. Publishing every internal package would turn every exported
helper and low-level type into a support burden before the product has enough evidence to freeze
those shapes.

## Decision

- External consumers use `@fairux/sdk` as the only supported programmatic API.
- `@fairux/core`, `@fairux/rules`, and adapter packages remain implementation details for now.
- The SDK is a curated facade, not a re-export of the entire monorepo.
- The root SDK entrypoint is browser-safe and exposes deterministic engine primitives only.
- Static HTML convenience APIs live under `@fairux/sdk/html`.
- Live DOM convenience APIs live under `@fairux/sdk/dom`.
- Public SDK reports default `toolVersion` from the installed SDK package version unless a consumer
  explicitly overrides it.
- The HTML and DOM public entrypoints enforce bounded inputs before or during adapter traversal.
- JavaScript consumers receive public `ScannerPolicyError` failures for malformed scanner options
  instead of generic property-access errors.
- Public scanner and adapter options reject unknown keys, symbol keys, non-plain objects, inherited
  policy fields, and invalid `null` values instead of silently ignoring them.
- SDK defaults apply only to `undefined`; `null` remains invalid input and is never converted to a
  default value.
- HTML and DOM per-scan option names and values are runtime-validated before scanning.
- Rule and severity override IDs are validated against the rules supplied by the configured
  built-in and custom rule packs. Unknown IDs fail scanner construction.
- The SDK follows the repository and CLI Node.js support contract:
  `^22.18.0 || >=24.11.0`.
- AST and Figma public entrypoints are deferred until their consumer contracts are proven.
- No npm publish is performed until npm scope ownership, package name availability, API review, and
  release approval are complete.

## Consequences

- External products can depend on one stable package while FairUX keeps freedom to rearrange
  internals.
- Browser consumers can import the root and DOM entrypoints without pulling Node-only code.
- Static HTML consumers get a high-level API without learning parse5 or `UiDocument`.
- Packed TypeScript and browser-platform consumer fixtures are part of the SDK compatibility gate.
- Some useful internals stay private by design. That is intentional; premature public exports would
  create compatibility debt.

## Non-goals

Publishing to npm, exposing AST/Figma as public SDK entrypoints, adding new rules, adding score,
adding fixes, or adding AI augmentation.
