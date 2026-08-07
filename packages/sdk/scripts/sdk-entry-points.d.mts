export declare class SdkEntryPointError extends Error {}

export interface SdkEntryPoint {
  /** As `exports` spells it: `.`, `./html`. */
  readonly subpath: string;
  /** As a consumer imports it: `@fairux/sdk`, `@fairux/sdk/html`. */
  readonly specifier: string;
  /** As the built artifacts are named: `index`, `html`. */
  readonly base: string;
}

/**
 * Every published entry point a manifest declares, in manifest order.
 *
 * `./package.json` is excluded — it is exported for tooling that reads the manifest and is not an
 * API. Throws `SdkEntryPointError` for a manifest with no name, no `exports` object, an export key
 * that is not a subpath, a subpath that does not map to a flat artifact name, or no entry points.
 */
export declare function sdkEntryPoints(manifest: unknown): SdkEntryPoint[];

/** The specifiers a consumer imports, in manifest order. */
export declare function sdkEntryPointSpecifiers(manifest: unknown): string[];
