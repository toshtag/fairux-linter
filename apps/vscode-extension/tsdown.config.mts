import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/extension.ts"],
  format: ["cjs"],
  // Declarations are inferred on for this package; make that explicit and scope the emit
  // program to `src` like every other package (see tsconfig.build.json).
  dts: { tsconfig: "tsconfig.build.json" },
  outExtensions: () => ({ js: ".js" }),
  clean: true,
  sourcemap: false,
  target: "es2022",
  deps: {
    neverBundle: ["vscode", "typescript"],
    alwaysBundle: [/^@fairux\//],
    onlyBundle: false,
  },
  inputOptions: {
    checks: { pluginTimings: false },
  },
});
