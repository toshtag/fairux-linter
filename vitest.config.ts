import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const sdkPackage = JSON.parse(
  readFileSync(fileURLToPath(new URL("./packages/sdk/package.json", import.meta.url)), "utf8"),
) as { version: string };

export default defineConfig({
  define: {
    __FAIRUX_SDK_VERSION__: JSON.stringify(sdkPackage.version),
  },
  test: {
    // Pick up *.test.ts across all packages/apps (node_modules excluded by default).
    include: ["**/*.{test,spec}.ts"],
    environment: "node",
    testTimeout: 10_000,
  },
});
