import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    content: "src/content.ts",
    popup: "src/popup.ts",
  },
  // IIFE so each output is a classic script: MV3 content scripts don't support ESM imports,
  // and the popup loads popup.js as a plain <script>. All workspace deps are inlined.
  format: ["iife"],
  outExtension: () => ({ js: ".js" }),
  noExternal: [/@fairux\/.*/],
  clean: true,
  sourcemap: false,
  target: "es2022",
});
