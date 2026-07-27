/**
 * npm Trusted Publishing preconditions — pure evaluation.
 *
 * Publishing `@fairux/sdk@0.1.0-beta.1` failed on
 * [run 30233771956](https://github.com/toshtag/fairux-linter/actions/runs/30233771956) with
 * `E404` on `PUT https://registry.npmjs.org/@fairux%2fsdk`. Nothing reached the registry.
 *
 * The cause was not the Trusted Publisher configuration. `actions/setup-node` was given
 * `registry-url`, which writes
 *
 *     //registry.npmjs.org/:_authToken=${NODE_AUTH_TOKEN}
 *
 * into the job's npm user config. The workflow deliberately sets no token — Trusted Publishing
 * uses OIDC — so every step logged `Failed to replace env in config: ${NODE_AUTH_TOKEN}`, and npm
 * saw a token entry it could not resolve rather than no token at all. It never entered the OIDC
 * exchange: the run's log contains no OIDC or trusted-publisher line anywhere. Provenance signing
 * still succeeded, because `--provenance` signs with the GitHub OIDC token directly and is a
 * separate step from being authorized to write to the registry.
 *
 * That failure mode is silent and expensive — a tag is consumed and cannot be moved — so the
 * preconditions are now asserted before the publish job does any work.
 *
 * This module decides; `check-trusted-publishing.mjs` gathers the inputs. **Nothing here reads or
 * returns a secret value.** The npm config is inspected only for the *presence* of an auth key,
 * and the OIDC variables only for non-emptiness; no value is stored in a message.
 */

/** Trusted Publishing over OIDC landed in this npm release. */
export const MINIMUM_NPM_VERSION = "11.5.1";

/** Environment variables GitHub provides only when `id-token: write` is granted. */
export const OIDC_ENV_VARS = Object.freeze([
  "ACTIONS_ID_TOKEN_REQUEST_URL",
  "ACTIONS_ID_TOKEN_REQUEST_TOKEN",
]);

/** Static-token variables that must be absent, since their presence suppresses OIDC. */
export const FORBIDDEN_TOKEN_ENV_VARS = Object.freeze(["NODE_AUTH_TOKEN", "NPM_TOKEN"]);

/** An npm config auth key, with or without a registry prefix (`//registry:_authToken=…`). */
const NPMRC_AUTH_ENTRY = /(^|[/:])(_authToken|_auth)\s*=/m;

/** Compare dotted versions numerically. Returns <0, 0, or >0. */
export function compareVersions(left, right) {
  const parse = (value) =>
    String(value)
      .split(".")
      .map((part) => Number.parseInt(part, 10) || 0);
  const a = parse(left);
  const b = parse(right);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

/** True when an npm config file declares any token-based authentication. */
export function hasTokenAuthEntry(npmrcContents) {
  if (typeof npmrcContents !== "string" || npmrcContents === "") return false;
  return NPMRC_AUTH_ENTRY.test(npmrcContents);
}

/**
 * Evaluate every precondition for an OIDC publish.
 *
 * @param {object} input
 * @param {string} input.npmVersion            output of `npm --version`
 * @param {Record<string, string|undefined>} input.env  the job environment
 * @param {string|null} [input.npmrcContents]  npm user config contents, or null when absent
 * @returns {{ ok: boolean, failures: string[] }} failures are safe to print verbatim
 */
export function assessTrustedPublishing({ npmVersion, env, npmrcContents = null }) {
  const failures = [];

  if (compareVersions(npmVersion, MINIMUM_NPM_VERSION) < 0) {
    failures.push(
      `npm ${npmVersion} cannot use Trusted Publishing; ${MINIMUM_NPM_VERSION} or newer is required.`,
    );
  }

  for (const name of OIDC_ENV_VARS) {
    if (!env[name]) {
      failures.push(`${name} is unset — the job is missing \`permissions: id-token: write\`.`);
    }
  }

  for (const name of FORBIDDEN_TOKEN_ENV_VARS) {
    if (env[name]) {
      failures.push(
        `${name} is set. A static token suppresses the OIDC exchange; Trusted Publishing must be the only credential.`,
      );
    }
  }

  if (hasTokenAuthEntry(npmrcContents)) {
    failures.push(
      "The npm user config declares token authentication. This is what broke run 30233771956: " +
        "`actions/setup-node` with `registry-url` writes an unresolved `${NODE_AUTH_TOKEN}` " +
        "placeholder, npm treats it as a credential, skips OIDC, and the registry PUT returns 404. " +
        "Remove `registry-url` from the publish job and pass `--registry` to `npm publish`.",
    );
  }

  return { ok: failures.length === 0, failures };
}
