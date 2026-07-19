import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Pick up *.test.ts across all packages/apps (node_modules excluded by default).
    include: ["**/*.{test,spec}.ts"],
    environment: "node",
  },
});
