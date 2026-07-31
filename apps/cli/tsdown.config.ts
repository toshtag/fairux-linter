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
    // The map ships, its `sourcesContent` does not. `fairux@0.1.0-beta.1` would otherwise have
    // published ~218 KB of embedded source — including `src/*.ts` — inside `dist/index.js.map`,
    // which is what the SDK's own source-map auditor refuses outright. `sources` and `mappings`
    // stay, so a stack trace from an installed CLI still names a file and a line.
    // `scripts/source-map-audit.mjs` is the check; this is the setting that satisfies it.
    sourcemapExcludeSources: true,
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
