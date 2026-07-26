export type TokenType = "word" | "punct" | "string" | "template" | "regex" | "number";

export type Token = {
  readonly type: TokenType;
  /** Cooked value for words, punctuators, and strings; null for regexes, numbers, and any
   * template literal containing an expression (which cannot be resolved statically). */
  readonly value: string | null;
  readonly line: number;
};

export type ModuleLoadKind =
  | "static-import"
  | "side-effect-import"
  | "export-from"
  | "dynamic-import"
  | "require";

export type ExtractedModuleSpecifier = {
  readonly specifier: string;
  /** The line the specifier literal starts on, not the line of the `import` keyword. */
  readonly line: number;
  readonly kind: ModuleLoadKind;
};

export type WorkspacePrivateSourceImport = {
  readonly specifier: string;
  readonly resolved: string;
  readonly importerWorkspace: string;
  readonly targetWorkspace: string;
};

export type WorkspaceBoundaryViolation = WorkspacePrivateSourceImport & {
  readonly line: number;
  readonly kind: ModuleLoadKind;
};

export declare function toPosixPath(filePath: string): string;
export declare function tokenize(source: string): Token[];
export declare function scanModuleSpecifiers(sourceText: string): ExtractedModuleSpecifier[];
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
