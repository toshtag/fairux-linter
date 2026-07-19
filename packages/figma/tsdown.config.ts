import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  dts: true,
  clean: true,
  sourcemap: true,
  target: "es2022",
  outExtensions: () => ({ js: ".js", dts: ".d.ts" }),
  inputOptions: {
    checks: { pluginTimings: false },
  },
});
