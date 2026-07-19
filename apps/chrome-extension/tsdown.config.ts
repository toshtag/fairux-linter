import { defineConfig } from "tsdown";

export default defineConfig([
  {
    entry: ["src/content.ts"],
    format: ["iife"],
    outExtensions: () => ({ js: ".js" }),
    outputOptions: { entryFileNames: "[name].js" },
    clean: true,
    sourcemap: false,
    target: "es2022",
    deps: {
      alwaysBundle: [/^@fairux\//],
    },
    inputOptions: {
      checks: { pluginTimings: false },
    },
  },
  {
    entry: ["src/popup.ts"],
    format: ["iife"],
    outExtensions: () => ({ js: ".js" }),
    outputOptions: { entryFileNames: "[name].js" },
    clean: false,
    sourcemap: false,
    target: "es2022",
    deps: {
      alwaysBundle: [/^@fairux\//],
    },
    inputOptions: {
      checks: { pluginTimings: false },
    },
  },
]);
