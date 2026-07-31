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

/**
 * Whether a version is the placeholder that reserves a package name, rather than a release.
 *
 * A bootstrap version is a prerelease, so `distTagFor` maps it to `next`. Callers that must not
 * publish it have to ask this before they ask for a dist-tag.
 */
export declare function isBootstrapPrerelease(version: string): boolean;

export declare function distTagFor(version: string): "next" | "latest" | null;
