export type NpmRegistryState =
  | { status: "absent" }
  | {
      status: "present";
      version: string;
      shasum: string;
      integrity: string;
    }
  | { status: "unavailable"; reason: string };

/** Raised only when `throwOnReadError` is set and the caller's own timeout killed the subprocess. */
export declare class RegistryReadTimeoutError extends Error {
  readonly name: "RegistryReadTimeoutError";
  readonly isRegistryReadTimeout: true;
}

export function getNpmRegistryState(
  spec: string,
  options?: {
    run?: (
      command: string,
      args: string[],
      options?: { timeout?: number; env?: NodeJS.ProcessEnv },
    ) => string;
    /**
     * When true, only `E404` is classified as `absent`; every other command, network, auth, or
     * timeout failure is raised rather than reported as `unavailable`.
     */
    throwOnReadError?: boolean;
  },
): NpmRegistryState;
