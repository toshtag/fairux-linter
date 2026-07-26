export type ViolationZone = "source-tree" | "outside-dist";

export type BuildOutputViolation = {
  readonly path: string;
  readonly zone: ViolationZone;
  readonly suffix: string;
};

export type PackageManifest = {
  readonly types?: unknown;
  readonly typings?: unknown;
  readonly exports?: unknown;
};

export declare const SOURCE_TREE_FORBIDDEN_SUFFIXES: readonly string[];
export declare const STRAY_ARTIFACT_SUFFIXES: readonly string[];
export declare const IGNORED_DIRECTORIES: readonly string[];

export declare function toPosixPath(filePath: string): string;
export declare function classifyPath(filePath: string): BuildOutputViolation | null;
export declare function auditPaths(filePaths: readonly string[]): BuildOutputViolation[];
export declare function declaredTypeEntries(manifest: PackageManifest): string[];
