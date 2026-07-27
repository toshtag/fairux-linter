export type ViolationZone = "source-tree" | "outside-dist";

export type BuildOutputViolation =
  | {
      readonly path: string;
      readonly zone: ViolationZone;
      /** A compiler or bundler output suffix landed somewhere it may not. */
      readonly reason: "artifact-suffix";
      readonly suffix: string;
    }
  | {
      readonly path: string;
      readonly zone: "outside-dist";
      /** Below a `dist` that is not a real workspace's output directory — extension irrelevant. */
      readonly reason: "unauthorized-dist";
      readonly suffix?: undefined;
    };

export type PackageManifest = {
  readonly types?: unknown;
  readonly typings?: unknown;
  readonly exports?: unknown;
};

/** The repository identities the classification is bound to. */
export type BuildOutputContext = {
  /** Workspace directories discovered from package manifests, e.g. `packages/core`. */
  readonly workspaceDirs: ReadonlySet<string>;
  /** Exact repo-relative paths, tracked in the Git index, that are hand-written sources. */
  readonly trackedHandwrittenSources: ReadonlySet<string>;
};

export declare const CODE_ARTIFACT_SUFFIXES: readonly string[];
export declare const HANDWRITTEN_SOURCE_ZONES: readonly RegExp[];
export declare const IGNORED_DIRECTORIES: readonly string[];

export declare function toPosixPath(filePath: string): string;
export declare function createBuildOutputContext(input: {
  workspaceDirs: Iterable<string>;
  trackedHandwrittenSources: Iterable<string>;
}): BuildOutputContext;
export declare function hasDistSegment(filePath: string): boolean;
export declare function isHandwrittenSourceZone(filePath: string): boolean;
export declare function isWorkspaceDistPath(filePath: string, context: BuildOutputContext): boolean;
export declare function isWorkspaceSourcePath(filePath: string): boolean;
export declare function isHandwrittenSourcePath(
  filePath: string,
  context: BuildOutputContext,
): boolean;
export declare function classifyPath(
  filePath: string,
  context: BuildOutputContext,
): BuildOutputViolation | null;
export declare function auditPaths(
  filePaths: readonly string[],
  context: BuildOutputContext,
): BuildOutputViolation[];
export declare function declaredTypeEntries(manifest: PackageManifest): string[];
export declare function classifyDeclaredTypeEntry(entry: string): string | null;
