/**
 * What `npm audit signatures` says about a package installed from the public registry.
 *
 * Extracted from the CLI's registry smoke when the SDK's needed the same check. The two packages
 * differ in their registry arguments — `@fairux/sdk` is scoped and resolves through
 * `@fairux:registry` first — and in nothing else that matters here: what a registry must say about a
 * published version's signature does not depend on which package it is, and a second copy would be a
 * second answer to the same question.
 *
 * **What this establishes, and what it does not.** The publish workflow reads back that npm
 * *reports* attestation metadata — a claim about an API response, made by the process that wrote it.
 * This is the independent half: a clean install, audited by `npm` against the registry's own keys, by
 * a process that published nothing. It still does not prove the attestation *describes* the workflow
 * run that produced the package; nothing in this repository does, and the release notes say so.
 *
 * Node built-ins only: this runs in smokes that install into a bare temporary project.
 */

/** The predicate an npm provenance attestation carries. */
export const SLSA_PROVENANCE_PREDICATE = "https://slsa.dev/provenance/v1";

/**
 * The npm that performs the audit, pinned.
 *
 * Not the runner's npm, and not `latest`. The audit's meaning depends on the verifier: an older npm
 * predates keyless attestation verification, and a floating `latest` would change what a green run
 * means without anything in this repository changing. A bump is a reviewed edit here.
 *
 * The floors this repository supports ship npm 10.9.3 (Node 22.18.0) and 11.6.1 (Node 24.11.0), so
 * the version is fetched rather than assumed present.
 */
export const SIGNATURE_AUDIT_NPM_VERSION = "11.19.0";

/**
 * The exact argv for the audit, so a test can pin it without a network call.
 *
 * `--include-attestations` is not optional: without it the response carries only the `invalid` and
 * `missing` lists, and "no invalid signatures" is a strictly weaker claim than "this package has
 * verifiable provenance".
 *
 * @param {readonly string[]} registryArgs  the package's own registry pinning
 * @returns {string[]}
 */
export function signatureAuditArgs(registryArgs) {
  return [
    "exec",
    "--yes",
    `--package=npm@${SIGNATURE_AUDIT_NPM_VERSION}`,
    "--",
    "npm",
    "audit",
    "signatures",
    "--json",
    "--include-attestations",
    ...registryArgs,
  ];
}

/**
 * What a signature audit of an installed tree says about one published package, as failures.
 *
 * Only the named package is held to the provenance standard. `verified` lists packages carrying
 * attestations, which most of a dependency tree does not, and failing there would be failing on
 * other maintainers' publish choices. An *invalid* signature anywhere is different: that is a
 * tampered artifact in the tree this package runs from.
 *
 * @param {{report: unknown, packageName: string, expectedVersion: string, registry: string,
 *   requiredPredicate?: string}} input
 * @returns {string[]} failures; empty means the audit supports the release
 */
export function signatureAuditFailures({
  report,
  packageName,
  expectedVersion,
  registry,
  requiredPredicate = SLSA_PROVENANCE_PREDICATE,
}) {
  const failures = [];
  const audit = /** @type {Record<string, unknown[]>} */ (report ?? {});
  const list = (key) => (Array.isArray(audit[key]) ? audit[key] : []);

  if (list("invalid").length > 0) {
    const names = list("invalid").map((entry) => `${entry?.name}@${entry?.version}`);
    failures.push(`npm audit signatures reports invalid signatures: ${names.join(", ")}`);
  }

  const missing = list("missing").find((entry) => entry?.name === packageName);
  if (missing) failures.push(`${packageName} has no registry signature`);

  const verified = list("verified").find((entry) => entry?.name === packageName);
  if (!verified) {
    failures.push(
      `${packageName} carries no verified attestation — the published package must have provenance`,
    );
    return failures;
  }
  if (verified.version !== expectedVersion) {
    failures.push(`the audited ${packageName} is ${verified.version}, expected ${expectedVersion}`);
  }
  if (verified.registry !== registry) {
    failures.push(`${packageName} was verified against ${verified.registry}, expected ${registry}`);
  }
  if (verified.attestations?.provenance?.predicateType !== requiredPredicate) {
    failures.push(
      `${packageName} carries no ${requiredPredicate} predicate (${verified.attestations?.provenance?.predicateType})`,
    );
  }
  return failures;
}

/**
 * Run the audit and return its failures.
 *
 * A subprocess failure, unparseable output, or a response that is not an object are all treated as
 * failures rather than as "no problems found". The one thing this must never do is let a broken
 * audit read as a clean one — that is the whole reason it exists.
 *
 * @param {{run: (cmd: string, args: string[]) => string, registryArgs: readonly string[],
 *   packageName: string, expectedVersion: string, registry: string}} input
 * @returns {string[]}
 */
export function auditInstalledSignatures({
  run,
  registryArgs,
  packageName,
  expectedVersion,
  registry,
}) {
  let raw;
  try {
    raw = run("npm", signatureAuditArgs(registryArgs));
  } catch (error) {
    return [`npm audit signatures failed to run: ${error.message}`];
  }
  let report;
  try {
    report = JSON.parse(raw);
  } catch (error) {
    return [`npm audit signatures returned unparseable JSON: ${error.message}`];
  }
  if (typeof report !== "object" || report === null || Array.isArray(report)) {
    return [`npm audit signatures returned ${Array.isArray(report) ? "an array" : typeof report}`];
  }
  return signatureAuditFailures({ report, packageName, expectedVersion, registry });
}
