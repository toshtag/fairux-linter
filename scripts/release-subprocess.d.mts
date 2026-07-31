export declare const DEFAULT_TIMEOUT: 120_000;

export interface ReleaseSubprocessOptions {
  timeout?: number;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
}

/**
 * Run a command and return its stdout.
 *
 * On failure the thrown error carries `stdout`, `stderr`, `status`, `signal`, and `code`. `code`
 * is `"ETIMEDOUT"` when `timeout` elapsed, which is how a caller tells a killed subprocess from a
 * command that failed on its own.
 */
export declare function run(
  cmd: string,
  args: string[],
  options?: ReleaseSubprocessOptions,
): string;

export declare function runSync(
  cmd: string,
  args: string[],
  options?: ReleaseSubprocessOptions,
): string;
