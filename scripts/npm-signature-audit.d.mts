export declare const SLSA_PROVENANCE_PREDICATE: string;
/** The npm that performs the audit, pinned — a bump is a reviewed edit. */
export declare const SIGNATURE_AUDIT_NPM_VERSION: string;
/** The exact argv for the audit, so a test can pin it without a network call. */
export declare function signatureAuditArgs(registryArgs: readonly string[]): string[];
/** What the audit says about one published package, as failures. */
export declare function signatureAuditFailures(input: {
  report: unknown;
  packageName: string;
  expectedVersion: string;
  registry: string;
  requiredPredicate?: string;
}): string[];
/** Run the audit and return its failures; a broken audit never reads as a clean one. */
export declare function auditInstalledSignatures(input: {
  run: (cmd: string, args: string[]) => string;
  registryArgs: readonly string[];
  packageName: string;
  expectedVersion: string;
  registry: string;
}): string[];
