export type ReleaseKind = "sdk" | "cli";

export type VerifiedReleaseBundle = {
  readonly tarball: string;
  readonly version: string;
  readonly spec: string;
  readonly distTag: string;
  readonly sha1: string;
  readonly sha256: string;
  readonly integrity: string;
};

export declare function packedTarballName(packageName: string, version: string): string;

/**
 * The dist-tag a version publishes to, or `null` when this repository's workflows will not release
 * it — which today means the bootstrap placeholder.
 */
export declare function releaseDistTag(version: string): string | null;

export declare function verifyReleaseBundle(input: {
  kind: ReleaseKind;
  tag: string;
  commit: string;
  manifest: { name: string; version: string };
  entries: readonly { name: string; kind: "file" | "directory" | "symlink" | "other" }[];
  readText: (name: string) => string;
  readBytes: (name: string) => Uint8Array;
  digest: (bytes: Uint8Array) => { sha1: string; sha256: string; integrity: string };
}): VerifiedReleaseBundle;
