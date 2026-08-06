import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runTests } from "@vscode/test-electron";

/**
 * Run the extension in a real VS Code, downloading one if this machine has none.
 *
 * Not part of `pnpm test`. It downloads a browser-sized archive and starts a desktop application,
 * which is neither offline nor cheap, and `verify:full` is both. It is `pnpm smoke:vscode` and a
 * workflow of its own, which is the same rule `release-paths.yml` follows for anything that is not
 * measured and fast.
 */
const here = dirname(fileURLToPath(import.meta.url));

await runTests({
  extensionDevelopmentPath: resolve(here, ".."),
  extensionTestsPath: resolve(here, "../test/host/suite.cjs"),
  // A throwaway profile, so a developer's own settings and extensions cannot decide the result.
  launchArgs: ["--disable-extensions", "--disable-gpu", "--no-sandbox"],
});
