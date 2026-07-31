export declare function resolveCommand(command: string, options?: { cwd?: string }): string;

export type RunCommandResult = {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
};

export type RunCommandOptions = {
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly input?: string;
  readonly timeout?: number;
  readonly maxBuffer?: number;
  /** Exit code to require; `null` accepts any. Defaults to `0`. */
  readonly expectStatus?: number | null;
};

export declare function runCommand(
  command: string,
  args?: readonly string[],
  options?: RunCommandOptions,
): RunCommandResult;
