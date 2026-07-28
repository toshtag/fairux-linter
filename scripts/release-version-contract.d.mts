export declare function classifyVersion(version: string): {
  valid: boolean;
  prerelease: boolean;
};
/** The first prerelease identifier of a version, or `null` when it carries none. */
export declare function firstPrereleaseIdentifier(version: string): string | null;

/**
 * Whether a version is a beta prerelease — narrower than being a prerelease at all.
 *
 * The SDK's additional restriction, shared by every P20 gate. Not a change to `distTagFor`'s
 * repository-wide policy, which also governs the CLI.
 */
export declare function isBetaPrerelease(version: string): boolean;

export declare function distTagFor(version: string): "next" | "latest" | null;
