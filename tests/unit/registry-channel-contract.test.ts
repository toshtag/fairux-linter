import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveRegistryChannel } from "../../scripts/registry-channel-contract.mjs";

/**
 * What a registry canary is allowed to conclude from a dist-tag reading.
 *
 * The canaries watched `next` only, and turned its reading into a version with four shell lines: a
 * `node -p` status read, a `node -p` version read, `check-semver.mjs`, and a `>> "$GITHUB_ENV"`
 * write. Watching `latest` as well is what made the missing fifth decision matter.
 *
 * **`latest` holds a placeholder until the first stable release.** npm sets `latest` to a package's
 * first published version whatever `--tag` says, and refuses to remove it, so both packages here
 * sit at `latest: 0.0.0-bootstrap.0`. Those four shell lines would have called that `present`,
 * validated it as SemVer, installed it, and smoked it — green, because a name reservation has
 * nothing in it to break. A canary reporting success over a package with no content is worse than
 * one reporting the absence, which is the reasoning `registry-cli-smoke.yml` already carried for
 * the period before `fairux` existed at all.
 */

const root = resolve(import.meta.dirname, "../..");
const entry = resolve(root, "scripts/resolve-registry-channel.mjs");

const present = (version: string) => ({
  status: "present",
  version,
  shasum: "d0e5c73de1a9e0b8c4b2e0f4a19f5f6e6a1d4c3b",
  integrity: "sha512-abc",
});

describe("resolving a channel to a version", () => {
  it("accepts a published release", () => {
    expect(resolveRegistryChannel({ state: present("0.1.0"), spec: "fairux@latest" })).toEqual({
      version: "0.1.0",
    });
    expect(
      resolveRegistryChannel({ state: present("0.1.0-beta.4"), spec: "@fairux/sdk@next" }),
    ).toEqual({ version: "0.1.0-beta.4" });
  });

  it("refuses the bootstrap placeholder, which is what latest holds before the first stable release", () => {
    const result = resolveRegistryChannel({
      state: present("0.0.0-bootstrap.0"),
      spec: "fairux@latest",
    });
    expect("failures" in result).toBe(true);
    if (!("failures" in result)) return;
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toContain("reserves the package name");
    // And says where the placeholder does still live, so the message is not read as "it is gone".
    expect(result.failures[0]).toContain("bootstrap");
  });

  it("refuses a channel npm has never created", () => {
    const result = resolveRegistryChannel({
      state: { status: "absent" },
      spec: "@fairux/sdk@latest",
    });
    expect(result).toEqual({ failures: ["@fairux/sdk@latest is absent on the public registry"] });
  });

  it("refuses a read that failed, and repeats the reason", () => {
    const result = resolveRegistryChannel({
      state: { status: "unavailable", reason: "npm view returned empty output" },
      spec: "fairux@next",
    });
    expect(result).toEqual({
      failures: [
        "fairux@next is unavailable on the public registry: npm view returned empty output",
      ],
    });
  });

  it("refuses a version that is not one", () => {
    // The registry response is untrusted input on its way into `GITHUB_ENV`, where a trailing
    // newline defines arbitrary variables for the steps that follow. A JavaScript `$` without the
    // `m` flag also matches before a trailing newline, so the whitespace test is not redundant with
    // the anchored SemVer grammar.
    for (const version of ["v1.0.0", "1.0", "1.0.0\nEVIL=1", " 1.0.0", "1.0.0 "]) {
      const result = resolveRegistryChannel({ state: present(version), spec: "fairux@next" });
      expect("failures" in result, version).toBe(true);
    }
  });

  it("refuses a reading that is not an object, or carries no version", () => {
    for (const state of [null, [], "present", 42]) {
      expect("failures" in resolveRegistryChannel({ state, spec: "fairux@next" })).toBe(true);
    }
    expect(
      "failures" in resolveRegistryChannel({ state: { status: "present" }, spec: "fairux@next" }),
    ).toBe(true);
  });
});

describe("the entry point the canaries run", () => {
  const withState = <T>(state: unknown, body: (paths: { state: string; env: string }) => T): T => {
    const dir = mkdtempSync(join(tmpdir(), "fairux-registry-channel-"));
    try {
      const statePath = join(dir, "registry-state.json");
      writeFileSync(statePath, JSON.stringify(state), "utf8");
      return body({ state: statePath, env: join(dir, "github-env") });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  const run = (args: string[]) => {
    try {
      return {
        status: 0,
        stderr: "",
        stdout: execFileSync(process.execPath, [entry, ...args], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        }),
      };
    } catch (error) {
      const failure = error as { status?: number; stdout?: string; stderr?: string };
      return {
        status: failure.status ?? -1,
        stdout: String(failure.stdout ?? ""),
        stderr: String(failure.stderr ?? ""),
      };
    }
  };

  it("writes the resolved version to GITHUB_ENV", () => {
    withState(present("0.1.0"), ({ state, env }) => {
      const result = run([
        "--state",
        state,
        "--spec",
        "fairux@latest",
        "--var",
        "CLI_VERSION",
        "--github-env",
        env,
      ]);
      expect(result.status).toBe(0);
      expect(readFileSync(env, "utf8")).toBe("CLI_VERSION=0.1.0\n");
    });
  });

  it("writes nothing and exits non-zero when the channel has no release on it", () => {
    withState(present("0.0.0-bootstrap.0"), ({ state, env }) => {
      const result = run([
        "--state",
        state,
        "--spec",
        "fairux@latest",
        "--var",
        "CLI_VERSION",
        "--github-env",
        env,
      ]);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("cannot be smoked");
      // Not merely "the smoke fails later": nothing is exported, so no later step can install it.
      expect(() => readFileSync(env, "utf8")).toThrow();
    });
  });

  it("refuses a variable name that is not one", () => {
    // It is written into `GITHUB_ENV` verbatim.
    withState(present("0.1.0"), ({ state, env }) => {
      const result = run([
        "--state",
        state,
        "--spec",
        "fairux@latest",
        "--var",
        "CLI_VERSION\nEVIL",
        "--github-env",
        env,
      ]);
      expect(result.status).toBe(2);
    });
  });

  it("exits 2 on a malformed invocation", () => {
    expect(run([]).status).toBe(2);
    expect(run(["--state", "/nonexistent", "--spec", "fairux@next"]).status).toBe(2);
  });

  it("exits 1 when the state file cannot be read", () => {
    const result = run([
      "--state",
      "/nonexistent/registry-state.json",
      "--spec",
      "fairux@next",
      "--var",
      "CLI_VERSION",
    ]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("could not read the registry state");
  });
});
