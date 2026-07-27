export declare function auditPublishedManifest(input: {
  kind: "sdk" | "cli";
  manifest: Record<string, unknown>;
  sourceManifest: Record<string, unknown>;
}): string[];

export declare function auditTarMembers(
  members: readonly { name: string; type: string; linkname: string }[],
): string[];
