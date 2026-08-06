export interface VerifyFullStep {
  readonly script: string;
  readonly why: string;
  readonly inFastVerify?: boolean;
}

export declare const VERIFY_FULL_STEPS: readonly VerifyFullStep[];
export declare function verifyFullScripts(): string[];
