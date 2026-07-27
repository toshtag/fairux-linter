export declare function classifyVersion(version: string): {
  valid: boolean;
  prerelease: boolean;
};
export declare function distTagFor(version: string): "next" | "latest" | null;
