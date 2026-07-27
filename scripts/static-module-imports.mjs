/**
 * Extract a module's static import specifiers using Node's own parser.
 *
 * A regex over `from "…"` / `import(…)` / `require(…)` missed the side-effect form — `import
 * "node:fs";` — so a crafted browser bundle carrying it passed the SDK's "no Node builtins" audit.
 * Rather than widen the regex again, ask Node.
 *
 * `vm.SourceTextModule` parses and exposes `dependencySpecifiers` without linking or evaluating,
 * so the source never runs. It needs `--experimental-vm-modules`, hence the child process.
 *
 * Scope, stated rather than implied: this returns **static** specifiers — `import`, side-effect
 * `import`, and `export … from`. Dynamic `import()` and `require()` are not static module requests
 * and are not included; callers that care must check them separately.
 */
import { execFileSync } from "node:child_process";

const PARSER = `
import vm from "node:vm";
let source = "";
process.stdin.on("data", (chunk) => { source += chunk; });
process.stdin.on("end", () => {
  try {
    const module = new vm.SourceTextModule(source);
    process.stdout.write(JSON.stringify({ specifiers: module.dependencySpecifiers }));
  } catch (error) {
    process.stdout.write(JSON.stringify({ error: String(error && error.message) }));
  }
});
`;

/**
 * @param {string} source  module source; never executed
 * @returns {string[]} static import specifiers
 * @throws when the source does not parse as an ES module
 */
export function staticImportSpecifiers(source) {
  const stdout = execFileSync(
    process.execPath,
    ["--experimental-vm-modules", "--no-warnings", "--input-type=module", "-e", PARSER],
    { input: source, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  const result = JSON.parse(stdout);
  if (result.error) throw new Error(`module did not parse: ${result.error}`);
  return result.specifiers;
}
