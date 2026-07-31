export declare function installedCliBinPath(projectDir: string, binName?: string): string;

export type InstalledCliResult = {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
};

export type InstalledCliRunner = (
  args: readonly string[],
  options?: { expectStatus?: number | null; input?: string; cwd?: string },
) => InstalledCliResult;

export declare function runInstalledCliSmoke(input: {
  runCli: InstalledCliRunner;
  projectDir: string;
  packageVersion: string;
  onPass?: (message: string) => void;
}): string[];
