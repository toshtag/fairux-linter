import { describe, expect, it } from "vitest";
import { PUBLIC_NPM_REGISTRY } from "../../../scripts/public-npm-registry.mjs";
import { getNpmRegistryState } from "../scripts/npm-registry-state.mjs";

function commandError(stderr: string): Error {
  const error = new Error("npm view failed") as Error & { stderr: string; stdout: string };
  error.stderr = stderr;
  error.stdout = "";
  return error;
}

describe("npm registry state — the registry is named, not resolved", () => {
  /**
   * `npm publish` names the registry explicitly; these reads did not, so they resolved through
   * npm's config layers. A single `@fairux:registry=` line in any project, user, or global
   * `.npmrc` would have had the pre-publish existence check and the post-publish digest
   * verification reading one registry while the publish wrote to another — each reporting success
   * about a different host.
   */
  it("passes the public registry and --prefer-online on every npm view", () => {
    let captured: { cmd: string; args: string[] } | undefined;
    getNpmRegistryState("@fairux/sdk@0.1.0-beta.2", {
      run(cmd, args) {
        captured = { cmd, args };
        return "{}";
      },
    });

    expect(captured).toEqual({
      cmd: "npm",
      args: [
        "view",
        "@fairux/sdk@0.1.0-beta.2",
        "version",
        "dist.shasum",
        "dist.integrity",
        "--json",
        "--registry=https://registry.npmjs.org/",
        // A cached metadata document is not evidence about the registry's current state, which is
        // the only thing this call is asking about.
        "--prefer-online",
      ],
    });
  });

  it("names the same registry the workflows publish to", () => {
    expect(PUBLIC_NPM_REGISTRY).toBe("https://registry.npmjs.org/");
  });
});

describe("npm registry state", () => {
  it("classifies E404 as absent", () => {
    const state = getNpmRegistryState("@fairux/sdk@9.9.9-fixture.0", {
      run() {
        throw commandError("npm ERR! code E404\nnpm ERR! 404 Not Found");
      },
    });

    expect(state).toEqual({ status: "absent" });
  });

  it("classifies package metadata as present", () => {
    const state = getNpmRegistryState("@fairux/sdk@9.9.9-fixture.0", {
      run() {
        return JSON.stringify({
          version: "9.9.9-fixture.0",
          "dist.shasum": "abc123",
          "dist.integrity": "sha512-test",
        });
      },
    });

    expect(state).toEqual({
      status: "present",
      version: "9.9.9-fixture.0",
      shasum: "abc123",
      integrity: "sha512-test",
    });
  });

  it("does not treat DNS errors as absent", () => {
    const state = getNpmRegistryState("@fairux/sdk@9.9.9-fixture.0", {
      run() {
        throw commandError("npm ERR! code ENOTFOUND\nnpm ERR! syscall getaddrinfo");
      },
    });

    expect(state.status).toBe("unavailable");
  });

  it("does not treat timeouts as absent", () => {
    const state = getNpmRegistryState("@fairux/sdk@9.9.9-fixture.0", {
      run() {
        throw commandError("npm ERR! code ETIMEDOUT\nnpm ERR! network timeout");
      },
    });

    expect(state.status).toBe("unavailable");
  });

  it("does not treat registry 5xx errors as absent", () => {
    const state = getNpmRegistryState("@fairux/sdk@9.9.9-fixture.0", {
      run() {
        throw commandError("npm ERR! 500 Internal Server Error");
      },
    });

    expect(state.status).toBe("unavailable");
  });

  it("does not treat malformed JSON as absent", () => {
    const state = getNpmRegistryState("@fairux/sdk@9.9.9-fixture.0", {
      run() {
        return "{not json";
      },
    });

    expect(state.status).toBe("unavailable");
  });
});
