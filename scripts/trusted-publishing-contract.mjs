/**
 * npm Trusted Publishing preconditions — pure evaluation.
 *
 * Publishing `@fairux/sdk@0.1.0-beta.1` failed on
 * [run 30233771956](https://github.com/toshtag/fairux-linter/actions/runs/30233771956) with
 * `E404` on `PUT https://registry.npmjs.org/@fairux%2fsdk`. Nothing reached the registry.
 *
 * `actions/setup-node` had been given `registry-url`, which writes
 *
 *     //registry.npmjs.org/:_authToken=${NODE_AUTH_TOKEN}
 *
 * into the job's npm user config. The workflow sets no token — Trusted Publishing uses OIDC — so
 * every step logged `Failed to replace env in config: ${NODE_AUTH_TOKEN}`, and npm saw a credential
 * it could not resolve rather than none. The run's log contains no OIDC or trusted-publisher line
 * anywhere. This matches the known `setup-node` failure mode, and the owner separately rechecked
 * the Trusted Publisher fields; removing `registry-url` is the recovery under test, and a
 * successful `0.1.0-beta.2` publication is what will confirm it end to end.
 *
 * Provenance signing succeeded regardless, because `--provenance` signs with the GitHub OIDC token
 * directly — a different step from being authorized to write to the registry.
 *
 * ## What this checks, and what it does not
 *
 * It verifies that the **local prerequisites** for an OIDC publish are present. It does not contact
 * npm and cannot confirm that a Trusted Publisher record exists or matches this repository; only a
 * real publish proves that.
 *
 * Nor does it save any work. The publish workflow is triggered by `push.tags`, so the tag already
 * exists by the time any step runs, and the unprivileged `prepare` job has already built, smoked,
 * audited, and uploaded the artifact by the time these checks run at all. What they prevent is an
 * npm registry read or a publish attempt made with a credential state that suppresses Trusted
 * Publishing.
 *
 * ## Secrets
 *
 * Nothing here reads or returns a secret value. Config files are reduced to the *names* of the
 * credential keys they declare, environment variables to their names. No value ever reaches a
 * message.
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

/**
 * npm config keys that carry a registry credential, lowercased.
 *
 * `_auth` and `_authToken` are the obvious two; npm also authenticates with `username` plus
 * `_password`, and with a client certificate via `certfile`/`keyfile`. An earlier version of this
 * check looked only for the first two and would have passed a job holding any of the others.
 *
 * `email` is not a credential. `auth-type` selects a login flow and is not one either.
 */
export const CREDENTIAL_KEYS = Object.freeze([
  "_auth",
  "_authtoken",
  "username",
  "_password",
  "certfile",
  "keyfile",
]);

/**
 * Convert an `npm_config_*` environment variable name to the npm config key it sets.
 *
 * Transcribed from npm 11.6.1, `@npmcli/config/lib/index.js`:
 *
 *     let key = envKey.slice('npm_config_'.length)
 *     if (!key.startsWith('//')) {          // don't normalize nerf-darted keys
 *       key = key.replace(/(?!^)_/g, '-').toLowerCase()
 *     }
 *
 * The `//` exemption is the part that matters here. It means
 * `npm_config_//registry.npmjs.org/:_authToken` reaches npm verbatim as a registry-scoped
 * credential — and an earlier version of this check, which lowercased and mangled every name,
 * classified all six registry-scoped credential forms as harmless.
 *
 * @returns {string | null} the npm config key, or null when the name is not an npm config variable.
 */
export function npmConfigKeyFromEnvironmentName(name) {
  const match = /^npm_config_(.*)$/i.exec(name);
  if (!match) return null;

  const key = match[1];
  if (key.startsWith("//")) return key;
  return key.replace(/(?!^)_/g, "-").toLowerCase();
}

/**
 * Reduce an npm config key to the credential it declares, if any.
 *
 * Handles the registry prefix (`//registry.npmjs.org/:_authToken` → `_authToken`) and the two
 * spellings environment normalization can produce for the same key (`_authtoken`, `_auth-token`).
 *
 * @returns {string | null} the credential key, or null when the key is not one.
 */
export function credentialKeyFromNpmConfigKey(key) {
  const bare = key
    .slice(key.lastIndexOf(":") + 1)
    .trim()
    .toLowerCase();
  const canonical = bare === "_auth-token" ? "_authtoken" : bare;
  return CREDENTIAL_KEYS.includes(canonical) ? canonical : null;
}

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

/**
 * Reduce npm config contents to the credential key names it declares.
 *
 * Parsed line by line rather than matched against the whole file. A regex over raw text both
 * missed real entries and flagged commented-out ones — `# //registry/:_authToken=disabled` is not
 * a credential.
 *
 * @returns {string[]} key names as written, without registry prefix or value.
 */
export function findCredentialKeys(contents) {
  if (typeof contents !== "string" || contents === "") return [];

  const found = [];
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#") || line.startsWith(";")) continue;

    const separator = line.indexOf("=");
    if (separator === -1) continue;

    // `//registry.npmjs.org/:_authToken` → `_authToken`; a bare `_authToken` stays as-is.
    const key = line.slice(0, separator).trim();
    if (credentialKeyFromNpmConfigKey(key)) found.push(key.slice(key.lastIndexOf(":") + 1).trim());
  }
  return found;
}

/** True when npm config contents declare any registry credential. */
export function hasCredentialEntry(contents) {
  return findCredentialKeys(contents).length > 0;
}

/**
 * Environment variables that hand npm a credential.
 *
 * npm reads any config key from `NPM_CONFIG_<KEY>` in either case, so this mirrors npm's own
 * key normalization — including the registry-scoped forms it leaves untouched. `NPM_CONFIG_REGISTRY`
 * and `NPM_CONFIG_AUTH_TYPE` are not credentials and must not match.
 *
 * @returns {string[]} variable names only — never their values.
 */
export function findCredentialEnvVars(env) {
  const found = [];
  for (const name of FORBIDDEN_TOKEN_ENV_VARS) {
    if (env[name]) found.push(name);
  }
  for (const [name, value] of Object.entries(env)) {
    if (!value) continue;
    const key = npmConfigKeyFromEnvironmentName(name);
    if (key && credentialKeyFromNpmConfigKey(key)) found.push(name);
  }
  return [...new Set(found)].sort();
}

/**
 * Evaluate every precondition for an OIDC publish.
 *
 * @param {object} input
 * @param {string} input.npmVersion  output of `npm --version`
 * @param {Record<string, string|undefined>} input.env  the job environment
 * @param {ReadonlyArray<{kind: string, path: string, contents: string}>} [input.configSources]
 *   every npm config file that applies to the publish, already read
 * @returns {{ ok: boolean, failures: string[] }} failures are safe to print verbatim
 */
export function assessTrustedPublishing({ npmVersion, env, configSources = [] }) {
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

  for (const name of findCredentialEnvVars(env)) {
    failures.push(
      `${name} is set. A static credential suppresses the OIDC exchange; Trusted Publishing must be the only one.`,
    );
  }

  for (const source of configSources) {
    const keys = findCredentialKeys(source.contents);
    if (keys.length === 0) continue;
    failures.push(
      `The ${source.kind} npm config (${source.path}) declares ${keys.join(", ")}. ` +
        "A credential here suppresses the OIDC exchange — this is how run 30233771956 failed, via " +
        "an `${NODE_AUTH_TOKEN}` placeholder written by `actions/setup-node` with `registry-url`.",
    );
  }

  return { ok: failures.length === 0, failures };
}
