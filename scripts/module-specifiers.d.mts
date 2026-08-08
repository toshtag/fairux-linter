export declare function moduleSpecifiers(
  input: { entryPoints: string[] } | { source: string; path: string },
): Promise<{ specifier: string; file: string; line: number }[]>;
