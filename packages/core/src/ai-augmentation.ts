/**
 * Optional AI augmentation — the contract, with no provider and no network call.
 *
 * This is the first thing in FairUX that would send a scanned page's content to somebody else, and
 * the first that could produce a signal nobody can reproduce. Both are why the shape comes first and
 * why every boundary here is a refusal rather than a convention.
 *
 * Three things it makes impossible:
 *
 * - An AI observation cannot reach `findings`. It has its own place in the report, or it does not
 *   exist. Deterministic findings are what baselines, fingerprints, SARIF, and `--fail-on` rest on.
 * - An AI observation cannot fail a build. Nothing that reads it can reach the exit code.
 * - Nothing leaves the machine that was not explicitly allowed. The payload is assembled from an
 *   allowlist, because a redaction step that removes known-bad content is a list of the leaks
 *   somebody already thought of.
 *
 * `@fairux/core` remains a deterministic engine with no AI in it. Nothing here calls a provider;
 * `runAiAugmentation` takes one as an argument, which is what keeps this file testable and this
 * package free of network code.
 */

import type { Finding, Severity, UiDocument } from "./types.js";

/** A provider that could not be used. Never thrown into a scan — recorded and returned. */
export type AiFailureCode =
  /** The provider threw. */
  | "provider-error"
  /** The provider did not answer within its budget. */
  | "timeout"
  /** The provider answered with something the contract does not accept. */
  | "invalid-output";

export interface AiFailure {
  readonly code: AiFailureCode;
  readonly message: string;
}

/**
 * Where an observation came from.
 *
 * Every field is required. An observation nobody can attribute is one nobody can check, and the
 * whole reason this output is separated from findings is that it needs checking.
 */
export interface AiProvenance {
  /** Provider identity, chosen by the caller. No provider's vocabulary appears in these types. */
  readonly provider: string;
  readonly model: string;
  readonly generatedAt: string;
  /** SHA-256 of the payload that was sent, so an observation can be tied to its input. */
  readonly inputChecksum: string;
}

/**
 * One thing an AI said about the page.
 *
 * Deliberately not a `Finding`. It has no fingerprint, no rule id, and no severity: those belong to
 * things a baseline can track and a build can fail on, and this is neither. `confidence` is the
 * provider's own claim and is labelled as such.
 */
export interface AiObservation {
  readonly id: string;
  readonly summary: string;
  /** What the provider says it saw, in its own words. Never rendered as a finding. */
  readonly detail: string;
  /** The provider's stated confidence. Not comparable with a rule's, and never used as one. */
  readonly statedConfidence?: string;
  /** A rule id this observation may relate to, when the provider was asked about one. */
  readonly relatedRuleId?: string;
  readonly provenance: AiProvenance;
}

export interface AiAugmentation {
  readonly observations: readonly AiObservation[];
  /** Every provider that could not be used. Present and empty when all of them were. */
  readonly failures: readonly AiFailure[];
  /** Always true. A field rather than a comment, so a consumer can assert on it. */
  readonly advisory: true;
}

/**
 * What a provider is allowed to receive.
 *
 * An allowlist, and the only thing in this file that decides what leaves the machine. A field added
 * to `UiDocument` does not appear here until someone adds it here, which is the opposite of a
 * redaction step that strips what it knows to strip.
 */
export interface AiPayload {
  /** The page's own text, normalized. No attributes, no URLs, no file paths. */
  readonly text: string;
  /** Tag names only, in document order, to give structure without content. */
  readonly tags: readonly string[];
  /** Page contexts the scan detected, which are FairUX's own vocabulary rather than page content. */
  readonly pageContexts: readonly string[];
}

export interface AiProvider {
  readonly name: string;
  /** Called with the payload and nothing else. */
  readonly observe: (payload: AiPayload) => Promise<readonly AiObservation[]>;
}

export interface AiAugmentationOptions {
  readonly provider: AiProvider;
  /** Milliseconds before the provider is abandoned. A scan is never held open longer than this. */
  readonly timeoutMs: number;
}

/**
 * Timers, read from the global object.
 *
 * Both browsers and Node have these; this package's TypeScript lib includes neither environment, so
 * the shape is declared here rather than pulling in a DOM or Node type dependency that
 * `check-runtime-safety` exists to keep out.
 */
const timers = globalThis as unknown as {
  readonly setTimeout?: (handler: () => void, timeout: number) => unknown;
  readonly clearTimeout?: (handle: unknown) => void;
};

/** Fields of a node that may be sent. Everything else is not sent, including anything added later. */
const ALLOWED_NODE_FIELDS = Object.freeze(["tag"] as const);

/**
 * Build what a provider receives.
 *
 * Assembled field by field from the allowlist above. Attributes are excluded outright: they carry
 * URLs, ids, tracking parameters, and whatever else a page put in them, and none of that is needed
 * to describe what a page says.
 */
export function buildAiPayload(doc: UiDocument): AiPayload {
  const nodes = doc.all();
  return Object.freeze({
    text: doc.root.normalizedText,
    tags: Object.freeze(nodes.map((node) => node[ALLOWED_NODE_FIELDS[0]])),
    pageContexts: Object.freeze(doc.pageContexts.map((signal) => signal.context)),
  });
}

/**
 * Run a provider, and never let it break the scan.
 *
 * A provider that throws, hangs, or answers with nonsense produces a recorded failure and an
 * augmentation with no observations. It cannot produce an exception, because the caller is a scan
 * that already succeeded.
 */
export async function runAiAugmentation(
  payload: AiPayload,
  options: AiAugmentationOptions,
): Promise<AiAugmentation> {
  const failed = (code: AiFailureCode, message: string): AiAugmentation =>
    Object.freeze({
      observations: Object.freeze([]),
      failures: Object.freeze([Object.freeze({ code, message })]),
      advisory: true as const,
    });

  if (typeof timers.setTimeout !== "function") {
    // Fail closed. No timer means no bounded call, and an unbounded call to a third party is the one
    // thing this function promises never to make.
    return failed(
      "provider-error",
      "no timer is available in this runtime, so a provider cannot be called within a budget",
    );
  }

  let timer: unknown;
  try {
    // The race is the whole non-blocking guarantee: a provider that never settles loses to the
    // timer, and the scan that called this is already complete either way.
    const observations = await Promise.race([
      options.provider.observe(payload),
      new Promise<never>((_resolve, reject) => {
        timer = timers.setTimeout?.(
          () =>
            reject(new Error(`provider ${options.provider.name} exceeded ${options.timeoutMs}ms`)),
          options.timeoutMs,
        );
      }),
    ]);
    if (!Array.isArray(observations)) {
      return failed("invalid-output", `provider ${options.provider.name} did not return a list`);
    }
    for (const observation of observations) {
      const invalid = invalidObservation(observation);
      if (invalid) {
        return failed("invalid-output", `provider ${options.provider.name}: ${invalid}`);
      }
    }
    return Object.freeze({
      observations: Object.freeze([...observations]),
      failures: Object.freeze([]),
      advisory: true as const,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return failed(message.includes("exceeded") ? "timeout" : "provider-error", message);
  } finally {
    if (timer !== undefined) timers.clearTimeout?.(timer);
  }
}

/** Why an observation is unusable, or `undefined`. Structural only — no judgement of the content. */
function invalidObservation(value: unknown): string | undefined {
  if (value === null || typeof value !== "object") return "an observation is not an object";
  const record = value as Partial<AiObservation> & Record<string, unknown>;
  if (typeof record.id !== "string" || record.id === "") return "an observation has no id";
  if (typeof record.summary !== "string" || record.summary === "") {
    return "an observation has no summary";
  }
  const provenance = record.provenance as Partial<AiProvenance> | undefined;
  if (!provenance) return "an observation has no provenance";
  for (const field of ["provider", "model", "generatedAt", "inputChecksum"] as const) {
    if (typeof provenance[field] !== "string" || provenance[field] === "") {
      return `an observation's provenance has no ${field}`;
    }
  }
  // The one field that would make an observation look like a finding. Refused rather than ignored:
  // a consumer that saw one would have every reason to treat it as one.
  for (const forbidden of ["fingerprint", "ruleId", "severity"]) {
    if (forbidden in record) return `an observation must not carry ${forbidden}`;
  }
  return undefined;
}

/**
 * The severities a build may fail on, as a reminder in code.
 *
 * Exported so a surface deciding an exit code has something to read that is obviously about findings
 * and obviously not about AI. There is no AI equivalent, and there is no function here that takes an
 * `AiAugmentation` and returns a boolean.
 */
export function findingSeverities(findings: readonly Finding[]): readonly Severity[] {
  return findings.map((finding) => finding.severity);
}
