import { describe, expect, it } from "vitest";
import { getNpmRegistryState } from "../scripts/npm-registry-state.mjs";

function commandError(stderr: string): Error {
  const error = new Error("npm view failed") as Error & { stderr: string; stdout: string };
  error.stderr = stderr;
  error.stdout = "";
  return error;
}

describe("npm registry state", () => {
  it("classifies E404 as absent", () => {
    const state = getNpmRegistryState("@fairux/sdk@0.1.0-beta.1", {
      run() {
        throw commandError("npm ERR! code E404\nnpm ERR! 404 Not Found");
      },
    });

    expect(state).toEqual({ status: "absent" });
  });

  it("classifies package metadata as present", () => {
    const state = getNpmRegistryState("@fairux/sdk@0.1.0-beta.1", {
      run() {
        return JSON.stringify({
          version: "0.1.0-beta.1",
          "dist.shasum": "abc123",
          "dist.integrity": "sha512-test",
        });
      },
    });

    expect(state).toEqual({
      status: "present",
      version: "0.1.0-beta.1",
      shasum: "abc123",
      integrity: "sha512-test",
    });
  });

  it("does not treat DNS errors as absent", () => {
    const state = getNpmRegistryState("@fairux/sdk@0.1.0-beta.1", {
      run() {
        throw commandError("npm ERR! code ENOTFOUND\nnpm ERR! syscall getaddrinfo");
      },
    });

    expect(state.status).toBe("unavailable");
  });

  it("does not treat timeouts as absent", () => {
    const state = getNpmRegistryState("@fairux/sdk@0.1.0-beta.1", {
      run() {
        throw commandError("npm ERR! code ETIMEDOUT\nnpm ERR! network timeout");
      },
    });

    expect(state.status).toBe("unavailable");
  });

  it("does not treat registry 5xx errors as absent", () => {
    const state = getNpmRegistryState("@fairux/sdk@0.1.0-beta.1", {
      run() {
        throw commandError("npm ERR! 500 Internal Server Error");
      },
    });

    expect(state.status).toBe("unavailable");
  });

  it("does not treat malformed JSON as absent", () => {
    const state = getNpmRegistryState("@fairux/sdk@0.1.0-beta.1", {
      run() {
        return "{not json";
      },
    });

    expect(state.status).toBe("unavailable");
  });
});
