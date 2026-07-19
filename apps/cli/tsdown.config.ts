import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import replace from "@rollup/plugin-replace";
import { defineConfig } from "tsdown";

const pkg = JSON.parse(
  readFileSync(fileURLToPath(new URL("./package.json", import.meta.url)), "utf8"),
) as { version: string };

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  dts: false,
  clean: true,
  sourcemap: true,
  target: "es2022",
  outExtensions: () => ({ js: ".js" }),
  outputOptions: {
    banner: "#!/usr/bin/env node",
  },
  plugins: [
    replace({
      values: { __FAIRUX_VERSION__: JSON.stringify(pkg.version) },
      preventAssignment: true,
    }),
  ],
  deps: {
    alwaysBundle: [/^@fairux\//],
    neverBundle: ["commander", "fast-glob", "jiti", "typescript", "parse5"],
  },
  inputOptions: {
    checks: { pluginTimings: false },
  },
});
