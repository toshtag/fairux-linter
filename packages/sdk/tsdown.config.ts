import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import replace from "@rollup/plugin-replace";
import { defineConfig } from "tsdown";
import { sdkEntryPoints } from "./scripts/sdk-entry-points.mjs";

const pkg = JSON.parse(
  readFileSync(fileURLToPath(new URL("./package.json", import.meta.url)), "utf8"),
) as { version: string; exports: Record<string, unknown> };

export default defineConfig({
  // Derived from `exports`, because that is what npm resolves. Listing the sources here as well
  // meant a new subpath export could be published pointing at a file the build never emitted.
  entry: sdkEntryPoints(pkg).map((entry) => `src/${entry.base}.ts`),
  format: ["esm"],
  dts: { tsconfig: "tsconfig.build.json" },
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
