export type WorkspacePrivateSourceImport = {
  readonly specifier: string;
  readonly resolved: string;
  readonly importerWorkspace: string;
  readonly targetWorkspace: string;
};

export type WorkspaceBoundaryViolation = WorkspacePrivateSourceImport & {
  readonly line: number;
};

export declare function toPosixPath(filePath: string): string;
export declare function stripCommentsAndKeepLayout(source: string): string;
export declare function extractModuleSpecifiers(line: string): string[];
export declare function resolveRelativeSpecifier(
  importerPath: string,
  specifier: string,
): string | null;
export declare function workspaceOf(filePath: string): string | null;
export declare function classifyWorkspacePrivateSourceImport(
  importerPath: string,
  specifier: string,
): WorkspacePrivateSourceImport | null;
export declare function auditSourceText(
  importerPath: string,
  sourceText: string,
): WorkspaceBoundaryViolation[];
