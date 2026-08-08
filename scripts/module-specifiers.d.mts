/** The source with comments and string contents blanked, and line breaks preserved. */
export declare function codeOnly(source: string): string;

/** Every module specifier the source loads, in source order. */
export declare function moduleSpecifiers(source: string): { specifier: string; line: number }[];
