export declare const RELEASE_REPOSITORY: string;

/** Refuse an environment that could redirect a release write. */
export declare function auditReleaseTargetEnvironment(
  env: NodeJS.ProcessEnv,
  options?: { expected?: string },
): string[];

/** Parse a `sha256  name` checksum file into basename → lowercase sha256. */
export declare function parseChecksumFile(contents: string): Map<string, string>;

/** What the published Release must be, compared against the bundle this run audited. */
export declare function auditPublishedRelease(input: {
  release: unknown;
  expectedAssets: Map<string, string>;
  downloadedAssets: Map<string, string>;
  expectedTag: string;
}): string[];
