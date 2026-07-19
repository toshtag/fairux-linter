import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/extension.ts"],
  // VS Code loads extensions as CommonJS; `vscode` is provided by the host (external).
  format: ["cjs"],
  outExtension: () => ({ js: ".js" }),
  external: ["vscode"],
  noExternal: [/@fairux\/.*/],
  clean: true,
  sourcemap: false,
  target: "es2022",
});
