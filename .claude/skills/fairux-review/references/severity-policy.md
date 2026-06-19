# Severity & confidence policy

## Two independent axes

- **`severity`** = how much this could distort a user's decision. `info | low | medium | high`.
- **`confidence`** = how sure the detector is, given its evidence. `low | medium | high`.

They are **independent**. A high-severity issue can have medium confidence (e.g. a free-trial CTA
with no nearby renewal text — serious *if* real, but "nearby" is heuristic). Always report both;
never collapse them into one number.

## Why static HTML caps confidence

The default scan reads static HTML — no computed styles, no runtime behavior. So:

- Visual rules (imbalance, close-visibility) are **experimental / info** — they can't see real
  layout. Don't present them as authoritative.
- Structural signals (a `checked` attribute, a missing reject control, scarcity text) are firmer.

When explaining, let confidence set your tone: high-confidence → "this is X"; low-confidence →
"this *may* be X; worth a look".

## Re-grading is config, not an AI decision

If a team thinks a rule is too loud/quiet, the fix is **`fairux.config.ts`**, not editing the
report or arguing in prose:

```ts
export default {
  rules: {
    "scarcity/scarcity-phrase": { severity: "info" }, // de-emphasize for this project
    "consent/bundled-consent": false,                 // disable entirely
  },
};
```

Severity overrides **do not move finding fingerprints**, so CI baselines stay stable across a
re-grade. **Confidence is not overridable** — it's a property of the evidence, not team policy.
Do not change severity/confidence yourself in a review; recommend a config change instead.

## Language

Risk-signal framing only. Say "may distort", "review recommended", "unverified scarcity claim".
Never "illegal", "malicious", "fraud", "violates GDPR". FairUX flags UX risk; legal conclusions
are out of scope.
