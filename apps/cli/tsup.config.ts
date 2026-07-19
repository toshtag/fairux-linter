import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  dts: false,
  clean: true,
  sourcemap: true,
  target: "es2022",
  banner: { js: "#!/usr/bin/env node" },
  // Bundle our internal `@fairux/*` workspace packages INTO dist so the published tarball carries no
  // `workspace:*` specifiers and needs no separate @fairux/* publishes. Third-party libraries stay
  // EXTERNAL as declared runtime dependencies — notably `typescript` (the ~9 MB compiler API used by
  // @fairux/ast) and `parse5`, which must not be inlined; npm resolves them at install time.
  noExternal: [/^@fairux\//],
  external: ["commander", "jiti", "typescript", "parse5"],
});
