import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import replace from "@rollup/plugin-replace";
import { defineConfig } from "tsdown";

const pkg = JSON.parse(
  readFileSync(fileURLToPath(new URL("./package.json", import.meta.url)), "utf8"),
) as { version: string };

export default defineConfig({
  entry: ["src/index.ts", "src/html.ts", "src/dom.ts"],
  format: ["esm"],
  dts: true,
  clean: true,
  sourcemap: false,
  target: "es2022",
  outExtensions: () => ({ js: ".js", dts: ".d.ts" }),
  plugins: [
    replace({
      values: { __FAIRUX_SDK_VERSION__: JSON.stringify(pkg.version) },
      preventAssignment: true,
    }),
  ],
  deps: {
    alwaysBundle: [/^@fairux\//],
  },
  inputOptions: {
    checks: { pluginTimings: false },
  },
});
