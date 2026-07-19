import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/extension.ts"],
  format: ["cjs"],
  outExtensions: () => ({ js: ".js" }),
  clean: true,
  sourcemap: false,
  target: "es2022",
  deps: {
    neverBundle: ["vscode"],
    alwaysBundle: [/^@fairux\//],
    onlyBundle: false,
  },
  inputOptions: {
    checks: { pluginTimings: false },
  },
});
