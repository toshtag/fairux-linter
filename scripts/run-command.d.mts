export declare function commandCandidateExtensions(
  command: string,
  environment?: { platform?: string; pathext?: string },
): string[];

export declare function isQuotableForCmd(argument: string): boolean;

export declare function windowsCommandProcessorArgs(commandLine: string): string[];

export declare function assertUnambiguousWindowsEnvironment(
  env: NodeJS.ProcessEnv,
  environment?: { platform?: string },
): void;

export declare function resolveWindowsCommandProcessor(
  env: NodeJS.ProcessEnv,
  dependencies?: { isFile?: (path: string) => boolean },
): string;

export declare function commandSearchDirectories(
  pathValue: string,
  environment?: { cwd?: string; platform?: string },
): string[];

export declare function resolveCommand(
  command: string,
  options?: { cwd?: string; env?: NodeJS.ProcessEnv },
): string;

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
