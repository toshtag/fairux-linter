import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "tsup";

// Single source of truth for the CLI version: read it from THIS package's package.json at build
// time and inline it via esbuild `define`. Keeping the version in one place means `fairux --version`
// and report.toolVersion always match the version npm actually publishes — no hand-edited constant
// to drift (it had already drifted: source said 0.3.0 while package.json said 0.1.0).
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
  banner: { js: "#!/usr/bin/env node" },
  // Inline the package version as a compile-time constant. The source declares `__FAIRUX_VERSION__`
  // (see version.ts) and esbuild replaces it with the JSON-encoded literal here.
  define: { __FAIRUX_VERSION__: JSON.stringify(pkg.version) },
  // Bundle our internal `@fairux/*` workspace packages INTO dist so the published tarball carries no
  // `workspace:*` specifiers and needs no separate @fairux/* publishes. Third-party libraries stay
  // EXTERNAL as declared runtime dependencies — notably `typescript` (the ~9 MB compiler API used by
  // @fairux/ast) and `parse5`, which must not be inlined; npm resolves them at install time.
  noExternal: [/^@fairux\//],
  external: ["commander", "jiti", "typescript", "parse5"],
});
