import { describe, expect, it } from "vitest";
import { FAIRUX_NPM_SCOPE, PUBLIC_NPM_REGISTRY } from "../../../scripts/public-npm-registry.mjs";
import { getNpmRegistryState, RegistryReadTimeoutError } from "../scripts/npm-registry-state.mjs";
import { registrySmokeInstallArgs } from "../scripts/registry-smoke-test.mjs";

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
   *
   * Adding `--registry` alone did not close it, because `@fairux/sdk` is scoped and npm consults
   * `@fairux:registry` first. These assertions fix the arguments; `scripts/test-scoped-registry-routing.mjs`
   * establishes where npm actually sends the request, which no string assertion can.
   */
  it("pins both the fallback registry and the @fairux scope key on every npm view", () => {
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
        // `--registry` alone is not enough for a scoped package: npm resolves `@fairux/sdk` through
        // `@fairux:registry` first and only falls back to `registry`, so a `@fairux:registry=` line
        // in any `.npmrc` would still decide where this read goes. Measured with
        // `npm config get @fairux:registry --registry=…`, which returns the `.npmrc` value.
        "--@fairux:registry=https://registry.npmjs.org/",
        // A cached metadata document is not evidence about the registry's current state, which is
        // the only thing this call is asking about.
        "--prefer-online",
      ],
    });
  });

  it("names the same registry the workflows publish to", () => {
    expect(PUBLIC_NPM_REGISTRY).toBe("https://registry.npmjs.org/");
    expect(FAIRUX_NPM_SCOPE).toBe("@fairux");
  });

  it("pins both keys on the post-publish install smoke too", () => {
    // This is the one release command that installs rather than reads metadata, and it carried no
    // registry arguments at all — so it would have installed from whatever `@fairux:registry` the
    // operator's `.npmrc` named, proving nothing about what was just published.
    expect(registrySmokeInstallArgs("@fairux/sdk@0.1.0-beta.2")).toEqual([
      "install",
      "@fairux/sdk@0.1.0-beta.2",
      "--no-audit",
      "--no-fund",
      "--registry=https://registry.npmjs.org/",
      "--@fairux:registry=https://registry.npmjs.org/",
      "--prefer-online",
    ]);
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

describe("npm registry state — what a retrying caller is allowed to treat as an answer", () => {
  /**
   * The default classification folds every failure that is not an E404 into `unavailable`, which is
   * right for a single read: the caller reports and stops either way. It is wrong for a caller that
   * retries, because `unavailable` reads as "the registry answered with something odd" and a killed
   * subprocess or an expired credential is not an answer at all. `throwOnReadError` is that
   * distinction, and nothing else changes.
   */
  const failing = (init: Record<string, unknown>) => () => {
    throw Object.assign(new Error(String(init.message ?? "npm view failed")), {
      stdout: "",
      stderr: "",
      ...init,
    });
  };

  it("still classifies E404 as absent, and never raises it", () => {
    const state = getNpmRegistryState("@fairux/sdk@9.9.9-fixture.0", {
      throwOnReadError: true,
      run: failing({ stderr: "npm ERR! code E404\nnpm ERR! 404 Not Found" }),
    });

    expect(state).toEqual({ status: "absent" });
  });

  it("still classifies malformed metadata as unavailable", () => {
    // The registry answered; the answer was not a version. That is a state, not a broken read.
    const state = getNpmRegistryState("@fairux/sdk@9.9.9-fixture.0", {
      throwOnReadError: true,
      run: () => "{not json",
    });

    expect(state.status).toBe("unavailable");
  });

  it("raises a subprocess the caller's timeout killed, as a typed timeout", () => {
    expect(() =>
      getNpmRegistryState("@fairux/sdk@9.9.9-fixture.0", {
        throwOnReadError: true,
        run: failing({ code: "ETIMEDOUT", message: "spawnSync npm ETIMEDOUT" }),
      }),
    ).toThrow(RegistryReadTimeoutError);
  });

  it("raises auth, network, and 5xx failures instead of calling them a registry state", () => {
    for (const stderr of [
      "npm ERR! code E401\nnpm ERR! 401 Unauthorized",
      "npm ERR! code ENOTFOUND\nnpm ERR! syscall getaddrinfo",
      "npm ERR! 500 Internal Server Error",
    ]) {
      expect(() =>
        getNpmRegistryState("@fairux/sdk@9.9.9-fixture.0", {
          throwOnReadError: true,
          run: failing({ stderr }),
        }),
      ).toThrow();
    }
  });

  it("leaves the single-read callers exactly as they were", () => {
    // Without the option, every one of those is still `unavailable` — the pre-publish plan and the
    // standalone CLI report and stop, and neither wants an exception.
    for (const init of [
      { code: "ETIMEDOUT" },
      { stderr: "npm ERR! code E401" },
      { stderr: "npm ERR! 500 Internal Server Error" },
    ]) {
      expect(
        getNpmRegistryState("@fairux/sdk@9.9.9-fixture.0", { run: failing(init) }).status,
      ).toBe("unavailable");
    }
  });
});
