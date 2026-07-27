import type { NpmConfigSource } from "./trusted-publishing-contract.d.mts";

export declare function collectNpmConfigSources(deps: {
  cwd: string;
  npmConfigGet: (key: string) => string;
  readFile: (path: string) => string;
  resolvePath: (path: string) => string;
}): NpmConfigSource[];
