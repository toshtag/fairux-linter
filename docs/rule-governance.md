# Rule governance

Rule governance metadata describes how a rule should be reviewed, interpreted, and maintained. It
does not change FairUX from a deterministic UX-risk scanner into a legal, fraud, or site-safety
system.

The contract is defined in
[`ADR P13-T1`](../design/decisions/P13-T1-rule-governance-contract.md).

## Maturity

Rules use four maturity states:

- `draft`: under development; not suitable for public stable packs.
- `experimental`: public but opt-in; evidence review or false-positive profile is incomplete.
- `stable`: reviewed against the current evidence and capability contract.
- `deprecated`: retained for compatibility but no longer recommended.

For this beta, `experimental?: boolean` remains the runtime opt-in gate. A rule with
`maturity: "draft"` or `maturity: "experimental"` must be `experimental: true` and
`defaultEnabled: false`. A stable rule must not be execution-experimental.

## Capabilities

`requiredCapabilities` names the observations a rule expects, such as structure, text, attributes,
DOM state, computed style, viewport, interaction, journey, form, or network observations.

This is metadata only until later capability and coverage work. Adding a capability ID does not mean
the current scanner can observe it, skip by it, or report coverage for it.

External capabilities must be namespaced, for example `purchase-guard/seller-page`.

## Evidence

`evidenceRequirements` states the evidence shape needed for a finding, such as `presence`,
`absence`, `text-match`, `attribute-state`, `comparison`, `runtime-state`, `sequence`, or
`network-observation`.

Evidence requirements are not confidence claims. A rule still needs tests and review notes showing
that its evidence is useful and deterministic.

## Jurisdictions and official sources

`jurisdictions` identify reviewed policy context. They do not assert that a page is legal,
illegal, compliant, or non-compliant.

`officialSources` record specific reviewed publisher material. Source URLs must use HTTPS and
`reviewedAt` must be a valid calendar date. Source metadata should point to primary or official
publisher pages when possible and should store concise summaries, not copied source text.

An official source mapping is evidence of review scope. It is not proof that a finding is legally
correct.

## Deprecation

Deprecated rules carry `deprecation` metadata with `since`, `reason`, and optionally a replacement
rule ID or removal target. Deprecation should preserve existing finding fingerprints unless a
separate migration decision justifies the change.

Removal requires a migration note.

## Limitations

`knownLimitations` should be explicit and observable. Good limitations say what the scanner cannot
see, such as computed visual prominence in static HTML, linked policy pages, cross-document flows,
or dynamic text that is not present in the scanned input.
