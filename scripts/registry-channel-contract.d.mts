/**
 * Turn a dist-tag reading into the exact published version a canary should install, or refuse it.
 *
 * Refuses an absent or unavailable channel, a value that is not a strict SemVer version, and the
 * bootstrap placeholder — which `latest` holds until a package's first stable release.
 */
export declare function resolveRegistryChannel(input: {
  state: unknown;
  spec: string;
}): { version: string } | { failures: string[] };
