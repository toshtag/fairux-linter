// `__FAIRUX_VERSION__` is replaced at build time by tsdown's @rollup/plugin-replace with this
// package's package.json version (see tsdown.config.ts). Declaring it lets the source typecheck and
// run under the test runner — which does NOT apply the replacement — where it stays `undefined` and
// we fall back to a sentinel. The published bundle never hits the fallback: the constant is always
// inlined.
declare const __FAIRUX_VERSION__: string | undefined;

/** The CLI version, single-sourced from package.json at build time. */
export const VERSION: string =
  typeof __FAIRUX_VERSION__ === "string" ? __FAIRUX_VERSION__ : "0.0.0-dev";
