export type NpmConfigSource = {
  readonly kind: "project" | "user" | "global";
  readonly path: string;
  readonly contents: string;
};

export type TrustedPublishingAssessment = {
  readonly ok: boolean;
  /** Human-readable reasons, safe to print: never contains a secret value. */
  readonly failures: string[];
};

export declare const MINIMUM_NPM_VERSION: string;
export declare const OIDC_ENV_VARS: readonly string[];
export declare const FORBIDDEN_TOKEN_ENV_VARS: readonly string[];
export declare const CREDENTIAL_KEYS: readonly string[];

export declare function compareVersions(left: string, right: string): number;
export declare function findCredentialKeys(contents: string | null | undefined): string[];
export declare function hasCredentialEntry(contents: string | null | undefined): boolean;
export declare function findCredentialEnvVars(env: Record<string, string | undefined>): string[];
export declare function assessTrustedPublishing(input: {
  npmVersion: string;
  env: Record<string, string | undefined>;
  configSources?: ReadonlyArray<NpmConfigSource>;
}): TrustedPublishingAssessment;
