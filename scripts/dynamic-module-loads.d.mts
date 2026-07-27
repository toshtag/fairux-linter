export declare function findDynamicModuleLoads(
  source: string,
): { kind: "import" | "require"; index: number }[];
