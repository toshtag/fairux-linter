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
