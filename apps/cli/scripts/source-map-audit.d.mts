/** Where the CLI's map sits relative to the repository root when it is built in place. */
export declare const CLI_SOURCE_MAP_DIR: "apps/cli/dist";

/**
 * Audit a published CLI source map.
 *
 * Pure: string and path arithmetic only, so the same call audits the built map and the packed one.
 *
 * @param entry how the map is named in failure messages
 * @param text the map's bytes, as UTF-8
 * @param options `mapDir` is where the map sits relative to the repository root
 * @returns failures; empty means the map satisfies the policy
 */
export declare function auditCliSourceMap(
  entry: string,
  text: string,
  options?: { mapDir?: string },
): string[];
