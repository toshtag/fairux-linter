export declare const INSTALL_TIME_SCRIPTS: readonly string[];

export declare function deepEqual(a: unknown, b: unknown): boolean;

export declare function expectedPackedManifest(input: {
  sourceManifest: Record<string, unknown>;
  workspaceVersions: Record<string, string>;
}): { manifest: Record<string, unknown> | null; failures: string[] };
