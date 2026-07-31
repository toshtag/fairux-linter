/**
 * The registry every release command must talk to — read, write, and verify.
 *
 * `npm publish` names it explicitly (the publish jobs give `actions/setup-node` no `registry-url`,
 * because that writes a `${NODE_AUTH_TOKEN}` placeholder and suppresses the OIDC exchange). The
 * `npm view` calls did not, so they resolved through npm's config layers instead: `registry=`,
 * `@fairux:registry=`, `NPM_CONFIG_REGISTRY`, and the project, user, and global `.npmrc`.
 *
 * `--registry` alone is not enough for `@fairux/sdk`. npm resolves a **scoped** package through
 * `@<scope>:registry` first and only falls back to `registry` when that key is absent — see
 * `pickRegistry()` in `npm-registry-fetch`. A command-line `--registry` sets the fallback, not the
 * scope key, so a `@fairux:registry=` line anywhere in the config chain still wins. Measured:
 *
 *     .npmrc: @fairux:registry=https://wrong.invalid/
 *     npm config get @fairux:registry --registry=https://registry.npmjs.org/
 *       → https://wrong.invalid/                                    (not overridden)
 *     npm config get @fairux:registry --registry=… --@fairux:registry=…
 *       → https://registry.npmjs.org/                               (overridden)
 *
 * So scoped commands pin both keys. Without that, a single `@fairux:registry` line would have had
 * the pre-publish existence check, the publish, and the post-publish digest verification each
 * reporting success about a different host.
 *
 * The CLI package (`fairux`) is unscoped and has no scope key to override; `--registry` is the
 * whole answer there.
 */
export const PUBLIC_NPM_REGISTRY = "https://registry.npmjs.org/";

/** The scope every published FairUX library lives under. */
export const FAIRUX_NPM_SCOPE = "@fairux";

/**
 * Registry arguments that pin both the fallback and the scope key.
 *
 * @param {string} registry
 * @param {string} scope  including the leading `@`
 * @param {{preferOnline?: boolean}} [options]  `--prefer-online` for reads: a cached metadata
 *   document is not evidence about the registry's current state, which is what those calls ask.
 * @returns {readonly string[]}
 */
export function registryArgsForScope(registry, scope, { preferOnline = false } = {}) {
  const args = [`--registry=${registry}`, `--${scope}:registry=${registry}`];
  if (preferOnline) args.push("--prefer-online");
  return Object.freeze(args);
}

/** Arguments every `npm view` of an `@fairux/*` package in the release path must carry. */
export const NPM_SDK_VIEW_REGISTRY_ARGS = registryArgsForScope(
  PUBLIC_NPM_REGISTRY,
  FAIRUX_NPM_SCOPE,
  { preferOnline: true },
);

/** Arguments `npm publish` of an `@fairux/*` package must carry. */
export const NPM_SDK_PUBLISH_REGISTRY_ARGS = registryArgsForScope(
  PUBLIC_NPM_REGISTRY,
  FAIRUX_NPM_SCOPE,
);

/**
 * Arguments the post-publish `npm install` smoke must carry.
 *
 * This is the one release command that installs from the registry rather than reading metadata, and
 * it was the last to still resolve through npm config. Measured with the same two-server fixture:
 * with no registry arguments, and with `--registry` alone, `npm install @fairux/sdk@…` went to the
 * `@fairux:registry` from the user config; only pinning both keys sent it to the intended host.
 * A smoke test that installs from somewhere other than where the release was published proves
 * nothing about the release.
 */
export const NPM_SDK_INSTALL_REGISTRY_ARGS = registryArgsForScope(
  PUBLIC_NPM_REGISTRY,
  FAIRUX_NPM_SCOPE,
  { preferOnline: true },
);

/**
 * Registry arguments for an unscoped package.
 *
 * `fairux` has no scope key, so `--registry` is the whole answer — and adding a `@fairux:registry`
 * pin here would be inert rather than harmless-but-tidy: it would suggest a resolution path this
 * package does not have, and `scoped-registry-routing`'s two-server fixture proves nothing about
 * a name npm never looks up a scope for.
 */
function registryArgs(registry, { preferOnline = false } = {}) {
  const args = [`--registry=${registry}`];
  if (preferOnline) args.push("--prefer-online");
  return Object.freeze(args);
}

/**
 * Arguments every `npm view` of the `fairux` CLI in the release path must carry.
 *
 * `--prefer-online` for the same reason the SDK's read carries it: a cached metadata document is
 * not evidence about the registry's current state, which is exactly what the publication plan and
 * the post-publish digest verification ask.
 */
export const NPM_CLI_VIEW_REGISTRY_ARGS = registryArgs(PUBLIC_NPM_REGISTRY, {
  preferOnline: true,
});

/** Arguments `npm publish` of the `fairux` CLI must carry. */
export const NPM_CLI_PUBLISH_REGISTRY_ARGS = registryArgs(PUBLIC_NPM_REGISTRY);
