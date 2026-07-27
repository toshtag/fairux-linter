export type TrustedPublishingAssessment = {
  readonly ok: boolean;
  /** Human-readable reasons, safe to print: never contains a secret value. */
  readonly failures: string[];
};

export declare const MINIMUM_NPM_VERSION: string;
export declare const OIDC_ENV_VARS: readonly string[];
export declare const FORBIDDEN_TOKEN_ENV_VARS: readonly string[];

export declare function compareVersions(left: string, right: string): number;
export declare function hasTokenAuthEntry(npmrcContents: string | null | undefined): boolean;
export declare function assessTrustedPublishing(input: {
  npmVersion: string;
  env: Record<string, string | undefined>;
  npmrcContents?: string | null;
}): TrustedPublishingAssessment;
