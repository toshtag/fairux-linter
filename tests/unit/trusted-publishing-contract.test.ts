import { describe, expect, it } from "vitest";
import {
  assessTrustedPublishing,
  compareVersions,
  FORBIDDEN_TOKEN_ENV_VARS,
  hasTokenAuthEntry,
  MINIMUM_NPM_VERSION,
  OIDC_ENV_VARS,
} from "../../scripts/trusted-publishing-contract.mjs";

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

describe("trusted publishing — npm config auth entries", () => {
  it("detects the setup-node placeholder that broke run 30233771956", () => {
    // This is the literal line `actions/setup-node` writes when given `registry-url`.
    expect(hasTokenAuthEntry("//registry.npmjs.org/:_authToken=${NODE_AUTH_TOKEN}\n")).toBe(true);
  });

  it.each([
    ["_authToken with a real value", "//registry.npmjs.org/:_authToken=npm_abc123\n"],
    ["bare _authToken", "_authToken=npm_abc123\n"],
    ["_auth basic entry", "//registry.npmjs.org/:_auth=aGVsbG8=\n"],
    ["padded assignment", "//registry.npmjs.org/:_authToken = npm_abc\n"],
    ["entry after other keys", "registry=https://registry.npmjs.org/\n_authToken=npm_abc\n"],
  ])("rejects %s", (_label, contents) => {
    expect(hasTokenAuthEntry(contents)).toBe(true);
    expect(assess({ npmVersion: "11.6.1", env: OIDC_READY, npmrcContents: contents }).ok).toBe(
      false,
    );
  });

  it.each([
    ["a registry-only config", "registry=https://registry.npmjs.org/\n"],
    ["no config at all", null],
    ["an empty config", ""],
    ["unrelated settings", "provenance=true\nignore-scripts=true\n"],
  ])("accepts %s", (_label, contents) => {
    expect(hasTokenAuthEntry(contents)).toBe(false);
    expect(assess({ npmVersion: "11.6.1", env: OIDC_READY, npmrcContents: contents }).ok).toBe(
      true,
    );
  });

  it("never echoes the npm config contents", () => {
    const secret = "npm_secretFromNpmrc";
    const { failures } = assess({
      npmVersion: "11.6.1",
      env: OIDC_READY,
      npmrcContents: `_authToken=${secret}\n`,
    });
    expect(failures.join(" ")).not.toContain(secret);
    expect(failures.join(" ")).toContain("setup-node");
  });
});

describe("trusted publishing — combined verdict", () => {
  it("reports every unmet precondition at once", () => {
    const { ok, failures } = assess({
      npmVersion: "10.9.3",
      env: { NODE_AUTH_TOKEN: "npm_x" },
      npmrcContents: "_authToken=npm_x\n",
    });
    expect(ok).toBe(false);
    // npm version + 2 missing OIDC vars + NODE_AUTH_TOKEN + npmrc entry.
    expect(failures).toHaveLength(5);
  });

  it("passes the configuration the fixed workflow produces", () => {
    expect(
      assess({
        npmVersion: "11.6.1",
        env: OIDC_READY,
        npmrcContents: null,
      }),
    ).toEqual({ ok: true, failures: [] });
  });
});
