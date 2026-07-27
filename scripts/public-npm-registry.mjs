/**
 * The registry every release command must talk to — read, write, and verify.
 *
 * `npm publish` names it explicitly (the publish jobs give `actions/setup-node` no `registry-url`,
 * because that writes a `${NODE_AUTH_TOKEN}` placeholder and suppresses the OIDC exchange). The
 * `npm view` calls did not, so they resolved through npm's config layers instead: `registry=`,
 * `@fairux:registry=`, `NPM_CONFIG_REGISTRY`, and the project, user, and global `.npmrc`. A single
 * `@fairux:registry` line would have had the pre-publish existence check and the post-publish
 * digest verification reading one registry while the publish wrote to another — both reporting
 * success about different things.
 *
 * One constant, used by every command, so read and write cannot diverge.
 */
export const PUBLIC_NPM_REGISTRY = "https://registry.npmjs.org/";

/**
 * Arguments every `npm view` in the release path must carry.
 *
 * `--prefer-online` because a cached metadata document is not evidence about the registry's current
 * state — which is the only thing these checks are asking about.
 */
export const NPM_VIEW_REGISTRY_ARGS = Object.freeze([
  `--registry=${PUBLIC_NPM_REGISTRY}`,
  "--prefer-online",
]);
