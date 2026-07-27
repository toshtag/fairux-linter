import { describe, expect, it } from "vitest";
import {
  assessTrustedPublishing,
  compareVersions,
  FORBIDDEN_TOKEN_ENV_VARS,
  findCredentialEnvVars,
  findCredentialKeys,
  hasCredentialEntry,
  MINIMUM_NPM_VERSION,
  OIDC_ENV_VARS,
} from "../../scripts/trusted-publishing-contract.mjs";

/** Wrap npm config contents as the single config source the collector would have produced. */
const project = (contents: string) => [
  { kind: "project" as const, path: "/repo/.npmrc", contents },
];

/** A job environment where OIDC is available and no static credential exists. */
const OIDC_READY = {
  ACTIONS_ID_TOKEN_REQUEST_URL: "https://token.actions.githubusercontent.com/…",
  ACTIONS_ID_TOKEN_REQUEST_TOKEN: "…",
};

const assess = (overrides: Parameters<typeof assessTrustedPublishing>[0]) =>
  assessTrustedPublishing({ npmVersion: "11.6.1", env: OIDC_READY, ...overrides });

describe("trusted publishing — npm version floor", () => {
  it.each([
    ["10.9.3", false],
    ["11.4.9", false],
    ["11.5.0", false],
    ["11.5.1", true],
    ["11.6.1", true],
    ["12.0.0", true],
  ])("npm %s → ok=%s", (npmVersion, expected) => {
    expect(assess({ npmVersion, env: OIDC_READY }).ok).toBe(expected);
  });

  it("names the floor in the failure", () => {
    const { failures } = assess({ npmVersion: "11.5.0", env: OIDC_READY });
    expect(failures.join(" ")).toContain(MINIMUM_NPM_VERSION);
  });

  it("compares versions numerically, not lexically", () => {
    expect(compareVersions("11.10.0", "11.9.0")).toBeGreaterThan(0);
    expect(compareVersions("11.5.1", "11.5.1")).toBe(0);
    expect(compareVersions("9.0.0", "10.0.0")).toBeLessThan(0);
  });
});

describe("trusted publishing — OIDC availability", () => {
  it.each(OIDC_ENV_VARS)("fails when %s is missing", (missing) => {
    const env = { ...OIDC_READY, [missing]: undefined };
    const { ok, failures } = assess({ npmVersion: "11.6.1", env });
    expect(ok).toBe(false);
    expect(failures.join(" ")).toContain(missing);
    expect(failures.join(" ")).toContain("id-token: write");
  });

  it("passes when both OIDC variables are present", () => {
    expect(assess({ npmVersion: "11.6.1", env: OIDC_READY }).ok).toBe(true);
  });
});

describe("trusted publishing — static credentials are disqualifying", () => {
  it.each(FORBIDDEN_TOKEN_ENV_VARS)("fails when %s is set", (name) => {
    const { ok, failures } = assess({
      npmVersion: "11.6.1",
      env: { ...OIDC_READY, [name]: "npm_xxx" },
    });
    expect(ok).toBe(false);
    expect(failures.join(" ")).toContain(name);
  });

  it("never echoes the token value", () => {
    const secret = "npm_thisMustNotAppear";
    const { failures } = assess({
      npmVersion: "11.6.1",
      env: { ...OIDC_READY, NODE_AUTH_TOKEN: secret },
    });
    expect(failures.join(" ")).not.toContain(secret);
  });
});

describe("trusted publishing — npm config credential entries", () => {
  it("detects the setup-node placeholder that broke run 30233771956", () => {
    // The literal line `actions/setup-node` writes when given `registry-url`.
    expect(hasCredentialEntry("//registry.npmjs.org/:_authToken=${NODE_AUTH_TOKEN}\n")).toBe(true);
  });

  it.each([
    ["_authToken with a real value", "//registry.npmjs.org/:_authToken=npm_abc123\n"],
    ["bare _authToken", "_authToken=npm_abc123\n"],
    ["_auth basic entry", "//registry.npmjs.org/:_auth=aGVsbG8=\n"],
    ["padded assignment", "//registry.npmjs.org/:_authToken = npm_abc\n"],
    ["entry after other keys", "registry=https://registry.npmjs.org/\n_authToken=npm_abc\n"],
    // npm authenticates with these too; an earlier version of this check looked only for _auth*.
    ["username", "//registry.npmjs.org/:username=toshtag\n"],
    ["_password", "//registry.npmjs.org/:_password=aGVsbG8=\n"],
    ["certfile", "//registry.npmjs.org/:certfile=/path/to/cert\n"],
    ["keyfile", "//registry.npmjs.org/:keyfile=/path/to/key\n"],
    ["uppercase key", "//registry.npmjs.org/:_AUTHTOKEN=npm_abc\n"],
  ])("rejects %s", (_label, contents) => {
    expect(hasCredentialEntry(contents)).toBe(true);
    expect(
      assess({ npmVersion: "11.6.1", env: OIDC_READY, configSources: project(contents) }).ok,
    ).toBe(false);
  });

  it.each([
    ["a registry-only config", "registry=https://registry.npmjs.org/\n"],
    ["an empty config", ""],
    ["unrelated settings", "provenance=true\nignore-scripts=true\n"],
    ["auth-type, which selects a login flow", "auth-type=web\n"],
    ["email, which is not a credential", "//registry.npmjs.org/:email=a@b.test\n"],
    // Commented-out entries were previously flagged as real credentials.
    ["a # comment", "# //registry.npmjs.org/:_authToken=disabled\n"],
    ["a ; comment", "; username=disabled\n"],
    ["a line with no assignment", "just-some-text\n"],
  ])("accepts %s", (_label, contents) => {
    expect(hasCredentialEntry(contents)).toBe(false);
    expect(
      assess({ npmVersion: "11.6.1", env: OIDC_READY, configSources: project(contents) }).ok,
    ).toBe(true);
  });

  it("names the key without its value", () => {
    expect(findCredentialKeys("//registry.npmjs.org/:_authToken=npm_abc\n")).toEqual([
      "_authToken",
    ]);
    expect(findCredentialKeys("//r/:username=u\n//r/:_password=p\n")).toEqual([
      "username",
      "_password",
    ]);
  });

  it("reports every applicable config source, naming each by kind and path", () => {
    const { ok, failures } = assess({
      npmVersion: "11.6.1",
      env: OIDC_READY,
      configSources: [
        { kind: "project", path: "/repo/.npmrc", contents: "_authToken=npm_a\n" },
        {
          kind: "user",
          path: "/home/u/.npmrc",
          contents: "registry=https://registry.npmjs.org/\n",
        },
        { kind: "global", path: "/etc/npmrc", contents: "//r/:username=u\n" },
      ],
    });
    expect(ok).toBe(false);
    expect(failures).toHaveLength(2);
    expect(failures[0]).toContain("project");
    expect(failures[0]).toContain("/repo/.npmrc");
    expect(failures[1]).toContain("global");
  });

  it("passes when no config source is present at all", () => {
    expect(assess({ npmVersion: "11.6.1", env: OIDC_READY, configSources: [] }).ok).toBe(true);
  });

  it("never echoes the npm config contents", () => {
    const secret = "npm_secretFromNpmrc";
    const { failures } = assess({
      npmVersion: "11.6.1",
      env: OIDC_READY,
      configSources: project(`_authToken=${secret}\n`),
    });
    expect(failures.join(" ")).not.toContain(secret);
    expect(failures.join(" ")).toContain("run 30233771956");
  });
});

describe("trusted publishing — credential environment variables", () => {
  it.each([
    "NODE_AUTH_TOKEN",
    "NPM_TOKEN",
    "NPM_CONFIG__AUTH",
    "NPM_CONFIG__AUTHTOKEN",
    "NPM_CONFIG_USERNAME",
    "NPM_CONFIG__PASSWORD",
    "NPM_CONFIG_CERTFILE",
    "NPM_CONFIG_KEYFILE",
  ])("rejects %s", (name) => {
    expect(findCredentialEnvVars({ [name]: "value" })).toContain(name);
    expect(assess({ npmVersion: "11.6.1", env: { ...OIDC_READY, [name]: "value" } }).ok).toBe(
      false,
    );
  });

  it("rejects the lowercase npm_config_ spelling npm also reads", () => {
    expect(findCredentialEnvVars({ npm_config__authtoken: "x" })).toEqual([
      "npm_config__authtoken",
    ]);
  });

  it.each(["NPM_CONFIG_AUTH_TYPE", "NPM_CONFIG_REGISTRY", "NPM_CONFIG_PROVENANCE"])(
    "accepts %s, which is not a credential",
    (name) => {
      expect(findCredentialEnvVars({ [name]: "value" })).toEqual([]);
      expect(assess({ npmVersion: "11.6.1", env: { ...OIDC_READY, [name]: "value" } }).ok).toBe(
        true,
      );
    },
  );

  it("ignores an empty value", () => {
    expect(findCredentialEnvVars({ NODE_AUTH_TOKEN: "" })).toEqual([]);
  });
});

describe("trusted publishing — combined verdict", () => {
  it("reports every unmet precondition at once", () => {
    const { ok, failures } = assess({
      npmVersion: "10.9.3",
      env: { NODE_AUTH_TOKEN: "npm_x" },
      configSources: project("_authToken=npm_x\n"),
    });
    expect(ok).toBe(false);
    // npm version + 2 missing OIDC vars + NODE_AUTH_TOKEN + one config source.
    expect(failures).toHaveLength(5);
  });

  it("passes the configuration the fixed workflow produces", () => {
    expect(assess({ npmVersion: "11.6.1", env: OIDC_READY, configSources: [] })).toEqual({
      ok: true,
      failures: [],
    });
  });
});
