import type { NpmRegistryState } from "../../../scripts/npm-registry-state.d.mts";

export declare function registrySmokeInstallArgs(spec: string): string[];

/** The reason a registry state cannot be smoked, or `null` when it can. */
export declare function unsmokableRegistryState(
  spec: string,
  state: NpmRegistryState,
): string | null;

/** The reason an installed version is not the one this run is evidence about, or `null`. */
export declare function installedVersionMismatch(input: {
  installed: unknown;
  expected: string;
}): string | null;

// `signatureAuditFailures` moved to `scripts/npm-signature-audit.mjs` when the SDK's registry smoke
// needed the same check. Re-exported so existing importers keep one place to look.
export { signatureAuditFailures } from "../../../scripts/npm-signature-audit.d.mts";
