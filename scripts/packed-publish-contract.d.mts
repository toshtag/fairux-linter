export declare function auditPublishedManifest(input: {
  manifest: Record<string, unknown>;
  sourceManifest: Record<string, unknown>;
  workspaceVersions: Record<string, string>;
}): string[];

export declare function auditTarMembers(
  members: readonly { name: string; type: string; linkname: string }[],
): { failures: string[]; names: string[] };
