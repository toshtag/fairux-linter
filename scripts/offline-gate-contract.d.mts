/** npm subcommands whose answer depends on what this repository has published. */
export declare const REGISTRY_STATE_SUBCOMMANDS: readonly string[];

/**
 * Every repository file a set of root `package.json` scripts reaches, and the commands they run.
 *
 * `files` are repository-relative and sorted; `commands` are the raw invocation strings.
 */
export declare function reachableFrom(
  root: string,
  scriptNames: readonly string[],
): { files: string[]; commands: string[] };

/** Every registry-state npm invocation reachable from a set of root scripts. */
export declare function registryStateCalls(
  root: string,
  scriptNames: readonly string[],
): { where: string; invocation: string }[];
