/**
 * What the registry must say about a published version's provenance.
 *
 * The release notes told a reader "the npm package carries provenance, so the registry can show
 * which workflow run and which commit produced it". The workflow verified `dist.shasum`,
 * `dist.integrity`, and the dist-tags, and never read `dist.attestations` at all — so the claim was
 * an assumption about what `npm publish --provenance` does rather than a statement about what the
 * registry ended up holding. A publish that silently produced no attestation would have been
 * announced as one that did.
 *
 * The shape below is measured, not guessed. `npm view @fairux/sdk@0.1.0-beta.2 dist.attestations
 * --json` on the public registry returns:
 *
 *     {
 *       "url": "https://registry.npmjs.org/-/npm/v1/attestations/@fairux%2fsdk@0.1.0-beta.2",
 *       "provenance": { "predicateType": "https://slsa.dev/provenance/v1" }
 *     }
 *
 * Only the fields this repository actually depends on are pinned: an attestation bundle exists at
 * an HTTPS URL, and it records a provenance predicate. npm may add fields, and a contract that
 * pinned the whole document would fail on the day it did.
 *
 * **What this proves and what it does not.** It proves the registry reports provenance attestation
 * metadata for this exact version. It does not verify a signature, fetch the bundle, or check that
 * the attestation describes this workflow run — `npm audit signatures` against a clean install does
 * that, and it belongs to the registry-installed smoke in M1-R4, where an install exists to audit.
 * Keeping the two apart is the same discipline that keeps npm's `dist.integrity` and the GitHub
 * Release checksum as separate claims in the release notes.
 *
 * Pure: the caller supplies the read, the clock, and the sleeper; this decides what the answers
 * mean. `verify-cli-provenance.mjs` is the thin entrypoint that supplies npm.
 */
import {
  REGISTRY_WAIT_DELAYS_MS,
  REGISTRY_WAIT_MAX_ELAPSED_MS,
} from "../../../scripts/release-registry-wait.mjs";

/** The predicate an npm Trusted Publishing release records. */
export const CLI_PROVENANCE_PREDICATE_PREFIX = "https://slsa.dev/provenance/";

/** How the registry's answer is classified, and which of the three the caller may retry. */
export const CLI_PROVENANCE_STATES = Object.freeze(["present", "absent", "invalid"]);

function httpsUrlFailure(label, value) {
  if (typeof value !== "string" || value === "") {
    return `${label} must be a non-empty string, got ${JSON.stringify(value)}`;
  }
  let url;
  try {
    url = new URL(value);
  } catch {
    return `${label} is not a URL: ${value}`;
  }
  if (url.protocol !== "https:") return `${label} is not an https URL: ${value}`;
  return null;
}

/**
 * Classify `dist.attestations` for one published version.
 *
 * `absent` is the only state a caller may retry, and for the same reason the registry digest
 * verification only retries absence: metadata that has not propagated yet becomes visible, and
 * metadata that is the wrong shape does not become the right shape by being read again.
 *
 * @param {object} input
 * @param {unknown} input.attestations  `dist.attestations`, or `undefined` when the field is absent
 * @returns {{state: "present" | "absent" | "invalid", failures: string[]}}
 */
export function classifyCliProvenance({ attestations }) {
  if (attestations === undefined || attestations === null) {
    return { state: "absent", failures: [] };
  }
  if (typeof attestations !== "object" || Array.isArray(attestations)) {
    return {
      state: "invalid",
      failures: [`dist.attestations is not an object, got ${typeof attestations}`],
    };
  }

  const failures = [];

  const urlFailure = httpsUrlFailure("dist.attestations.url", attestations.url);
  if (urlFailure) failures.push(urlFailure);

  const provenance = attestations.provenance;
  if (typeof provenance !== "object" || provenance === null || Array.isArray(provenance)) {
    failures.push(
      "dist.attestations records no provenance predicate; this version was not published with " +
        "--provenance, or npm did not record one",
    );
  } else {
    const predicateFailure = httpsUrlFailure(
      "dist.attestations.provenance.predicateType",
      provenance.predicateType,
    );
    if (predicateFailure) {
      failures.push(predicateFailure);
    } else if (!provenance.predicateType.startsWith(CLI_PROVENANCE_PREDICATE_PREFIX)) {
      // Named rather than pinned to an exact version: SLSA revises its predicate, and a release
      // must not fail on the day npm follows. What must not change is that it *is* a provenance
      // predicate rather than some other attestation type.
      failures.push(
        `dist.attestations.provenance.predicateType is not a SLSA provenance predicate: ` +
          provenance.predicateType,
      );
    }
  }

  // An object that exists but does not describe provenance is a wrong answer, not a late one. The
  // publish already happened; retrying would only spend the deadline before reporting the same
  // thing.
  return failures.length > 0 ? { state: "invalid", failures } : { state: "present", failures: [] };
}

/**
 * Read until the metadata is present, or the deadline is reached.
 *
 * The clock, the sleeper, and the reader are injected so the deadline is asserted exactly and the
 * tests take no real time — the same shape as `scripts/release-registry-wait.mjs`, whose schedule
 * and ceiling this reuses rather than inventing a second one.
 *
 * @returns {Promise<{state: string, failures: string[], attempts: number}>}
 */
export async function waitForCliProvenance({
  spec,
  read,
  sleep,
  now,
  delaysMs = REGISTRY_WAIT_DELAYS_MS,
  maxElapsedMs = REGISTRY_WAIT_MAX_ELAPSED_MS,
  log = console.log,
}) {
  const started = now();
  const elapsed = () => now() - started;

  for (let attempt = 1; ; attempt += 1) {
    const classified = classifyCliProvenance({ attestations: await read(spec) });
    if (classified.state !== "absent") return { ...classified, attempts: attempt };

    const scheduled = attempt <= delaysMs.length ? delaysMs[attempt - 1] : undefined;
    const remaining = maxElapsedMs - elapsed();
    if (scheduled === undefined || scheduled > remaining) {
      return {
        state: "absent",
        attempts: attempt,
        failures: [
          `npm reports no provenance attestation for ${spec} after ${attempt} attempt(s) over ` +
            `${Math.round(elapsed())}ms. The publish used --provenance, so either the registry did ` +
            "not record one or it has not become visible within the deadline.",
        ],
      };
    }
    log(`attempt ${attempt}: no attestation metadata for ${spec} yet; retrying in ${scheduled}ms`);
    await sleep(scheduled);
  }
}
