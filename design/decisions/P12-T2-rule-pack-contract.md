---
id: P12-T2
title: "Versioned rule pack contract"
status: accepted
date: 2026-07-15
---

# ADR P12-T2: Versioned Rule Pack Contract

## Context

FairUX currently runs a rule array. That is enough for internal surfaces, but it is too weak for
third-party extension. A public ecosystem needs provenance, compatibility checks, deterministic
ordering, duplicate rejection, and a clear unit of versioning.

The extension unit is a rule pack, not a naked array.

## Decision

- `RulePack` is the public extension unit.
- Each pack has a stable namespaced `id`, semantic `version`, `engineApiVersion`, title, and status.
- `engineApiVersion` starts at `"1"` and is separate from package semver.
- Unsupported engine API versions fail fast with the pack ID and version in the error.
- Duplicate pack IDs fail fast.
- Duplicate rule IDs fail fast.
- Rule IDs cannot use the reserved names `__proto__`, `constructor`, or `prototype`.
- Pack order follows input order; rule order follows pack order and then pack-local rule order.
- `composeRulePacks()` validates its JavaScript options before composition. `includeExperimental`
  is optional, but when present it must be a boolean and unknown option keys fail fast.
- Built-in FairUX rules are exposed as a built-in rule pack rather than as a special case.
- Stateful regular expressions (`global` or `sticky`) are rejected during composition because their
  `lastIndex` state can make scans non-deterministic.
- RulePack dictionary group names are arbitrary strings. Prototype-sensitive names such as
  `constructor`, `toString`, and `__proto__` are stored in prototype-free maps and remain valid
  dictionary keys.
- Only `undefined` means a RulePack dictionary is absent. `null`, booleans, numbers, strings,
  arrays, and non-plain objects are invalid dictionary values.
- RulePack arrays must be dense. Sparse `rules`, metadata arrays, and dictionary pattern arrays fail
  composition with `RulePackError` at the offending field path.
- RulePack objects, pack metadata, rules, and rule metadata are strict plain own-property objects.
  Unknown fields, symbol fields, inherited fields, and class instances fail composition instead of
  being silently ignored.
- Custom rule execution results are validated and normalized into fresh data snapshots at runtime.
  `evaluate()` must return a dense array of valid findings, and `ctx.createFinding()` inputs must
  preserve the public report schema. Finding, evidence, locator, source, and reference objects are
  snapshotted before aggregation so getters or later mutation cannot alter the public report. Every
  custom-rule result property is read at most once during normalization; that same value is used for
  validation and the FairUX-owned snapshot. Accessor properties cannot present one value to the
  validator and another to the report, and accessor failures become `RulePackError` before
  fingerprinting, summary aggregation, or JSON serialization. Custom findings must keep `ruleId`
  and `category` aligned with their rule metadata, and finding IDs are unique within a report.
  Malformed rule output fails with `RulePackError` before summary aggregation or JSON serialization.
- Pack metadata, rule metadata, rules arrays, and dictionary arrays are cloned and frozen during
  composition so later mutation of the source pack does not change a created scanner.
- Pack and external rule versions are validated as semantic versions.
- Third-party rule packs are trusted executable JavaScript. FairUX does not sandbox `evaluate()`;
  consumers must pin, review, and bundle trusted packs rather than dynamically loading unknown code.

## Consequences

- External rule authors get a stable, versioned package boundary.
- Consumers get deterministic scan behavior and actionable validation failures.
- Misspelled override IDs do not silently leave rules enabled or unchanged.
- RulePack composition cannot create custom rules that scanner policy maps cannot safely override.
- Built-in FairUX behavior remains local-only and deterministic, while third-party pack behavior is
  explicitly controlled by the consumer's dependency trust decision.
- Existing built-in rule IDs remain unchanged. Namespacing is recommended for new external rules,
  but P12 does not rename existing FairUX rule IDs.

## Non-goals

Remote rule loading, plugin discovery, package registry policy, rule marketplace behavior, or any
new detection capability.
