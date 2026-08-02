/**
 * Deliberately loose: this describes a plain-JS governance script that reads whatever `meta` and
 * dictionary shapes the built package hands it. Narrowing it to `RuleMeta` and `KeywordDictionary`
 * would couple a check to the types it exists to check, and would refuse a pack from outside this
 * repository for reasons that have nothing to do with detection.
 */
export type DetectionDigestRule = { readonly meta: object };

export type DetectionDigestInput = {
  readonly rules?: readonly DetectionDigestRule[];
  readonly journeyRules?: readonly DetectionDigestRule[];
  /** Locale → group → patterns, as the runtime holds them. */
  readonly dictionary?: object;
};

export function buildDetectionDigestPayload(input: DetectionDigestInput): Record<string, unknown>;

/** Lowercase hex SHA-256 over the canonical payload. */
export function computeDetectionDigest(input: DetectionDigestInput): string;
