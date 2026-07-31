import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { auditCliSourceMap, CLI_SOURCE_MAP_DIR } from "../scripts/source-map-audit.mjs";

/**
 * The published map's contents, which the tarball's file allowlist says nothing about.
 *
 * `fairux@0.1.0-beta.1` was ready to publish `dist/index.js.map` with 11 non-empty
 * `sourcesContent` entries — about 218 KB, including `src/load-config.ts`, `src/scan-file.ts`,
 * `src/version.ts`, and `src/index.ts`. The SDK's own auditor rejects any non-empty entry, so one
 * repository was about to ship two publishable packages under opposite source-map policies with
 * neither of them written down. `sourcemapExcludeSources` is the setting; this is the check.
 *
 * The built map is audited here as well as the packed one, so a build config change that
 * reintroduces embedded source fails in unit tests rather than at pack time.
 */

const cliDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const builtMap = resolve(cliDir, "dist/index.js.map");

/** A map that satisfies the policy, as the parts each case then breaks one of. */
function validMap(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    version: 3,
    file: "index.js",
    names: [],
    sources: ["../src/index.ts", "../../../packages/core/dist/index.js"],
    mappings: "AAAA",
    ...overrides,
  });
}

describe("the built CLI source map", () => {
  it("exists — the policy keeps the map, it only empties it", () => {
    expect(existsSync(builtMap)).toBe(true);
  });

  it("satisfies the published-map policy", () => {
    expect(auditCliSourceMap("dist/index.js.map", readFileSync(builtMap, "utf8"))).toEqual([]);
  });

  it("carries no sourcesContent at all", () => {
    const map = JSON.parse(readFileSync(builtMap, "utf8")) as Record<string, unknown>;
    expect(map.sourcesContent).toBeUndefined();
    // Still a usable map: the two fields a debugger needs are the ones that stayed.
    expect(Array.isArray(map.sources) && map.sources.length).toBeGreaterThan(0);
    expect(map.mappings).toBeTypeOf("string");
  });

  it("keeps repository-relative source paths, which is the whole reason the map ships", () => {
    const map = JSON.parse(readFileSync(builtMap, "utf8")) as { sources: string[] };
    // The SDK's auditor rejects exactly this. Pinning it here records that the CLI's policy
    // differs on purpose, rather than leaving the difference to be discovered as a bug.
    expect(map.sources.some((source) => source.startsWith("../src/"))).toBe(true);
    expect(auditCliSourceMap("dist/index.js.map", JSON.stringify(map))).toEqual([]);
  });
});

describe("auditCliSourceMap", () => {
  it("accepts a map with no sourcesContent key", () => {
    expect(auditCliSourceMap("m", validMap())).toEqual([]);
  });

  it("accepts sourcesContent that carries nothing", () => {
    expect(auditCliSourceMap("m", validMap({ sourcesContent: [null, ""] }))).toEqual([]);
  });

  it("refuses a single non-empty sourcesContent entry", () => {
    expect(
      auditCliSourceMap("m", validMap({ sourcesContent: [null, "export const x = 1;"] })),
    ).toEqual([expect.stringContaining("sourcesContent[1] embeds 19 bytes of source")]);
  });

  it("refuses sourcesContent that is not an array", () => {
    expect(auditCliSourceMap("m", validMap({ sourcesContent: "everything" }))).toEqual([
      expect.stringContaining("must be absent or an array"),
    ]);
  });

  it.each([
    ["/Users/tochi/Development/fairux-linter/apps/cli/src/index.ts", "a POSIX home path"],
    ["/home/runner/work/fairux-linter/apps/cli/src/index.ts", "a CI runner path"],
    ["C:\\Users\\build\\fairux\\src\\index.ts", "a Windows drive path"],
    ["\\\\server\\share\\index.ts", "a UNC path"],
  ])("refuses %s (%s)", (source) => {
    expect(auditCliSourceMap("m", validMap({ sources: [source] }))).toEqual([
      expect.stringContaining("absolute path"),
    ]);
  });

  it.each([
    ["file:///Users/tochi/src/index.ts", "a URL"],
    ["https://example.invalid/index.ts", "a URL"],
    ["../../../.env", "an environment file"],
    ["../../../.env.local", "an environment file"],
    ["../../../.npmrc", "an npm config file"],
    ["../secrets/token.ts", "a secret path"],
    ["../secret.ts", "a secret path"],
  ])("refuses %s as %s", (source, label) => {
    expect(auditCliSourceMap("m", validMap({ sources: [source] }))).toEqual([
      expect.stringContaining(`looks like ${label}`),
    ]);
  });

  it("refuses a path that climbs above the repository root", () => {
    // From `apps/cli/dist`, three levels up is the repository root; four is somebody's disk.
    expect(auditCliSourceMap("m", validMap({ sources: ["../../../../elsewhere/x.ts"] }))).toEqual([
      expect.stringContaining("escapes the repository"),
    ]);
  });

  it("accepts a path that climbs exactly to the repository root", () => {
    expect(
      auditCliSourceMap("m", validMap({ sources: ["../../../packages/rules/dist/index.js"] })),
    ).toEqual([]);
  });

  it("anchors the escape check on the given map directory, not the process cwd", () => {
    // The privileged publish job runs this from a different directory than `pnpm pack:smoke`
    // does. The same source has to get the same verdict from both.
    const source = "../../../packages/core/dist/index.js";
    expect(auditCliSourceMap("m", validMap({ sources: [source] }), { mapDir: "dist" })).toEqual([
      expect.stringContaining("escapes the repository"),
    ]);
    expect(
      auditCliSourceMap("m", validMap({ sources: [source] }), { mapDir: CLI_SOURCE_MAP_DIR }),
    ).toEqual([]);
  });

  it("refuses a map stripped down to a shell", () => {
    // Deleting `sourcesContent` by emitting an empty map would satisfy every rule above.
    expect(auditCliSourceMap("m", validMap({ mappings: "" }))).toEqual([
      expect.stringContaining("no mappings"),
    ]);
    expect(auditCliSourceMap("m", validMap({ sources: [] }))).toEqual([
      expect.stringContaining("lists no sources"),
    ]);
  });

  it("refuses a wrong map version", () => {
    expect(auditCliSourceMap("m", validMap({ version: 2 }))).toEqual([
      expect.stringContaining("version must be 3"),
    ]);
  });

  it("refuses a source that is not a non-empty string", () => {
    expect(auditCliSourceMap("m", validMap({ sources: [42] }))).toEqual([
      expect.stringContaining("sources[0] is not a non-empty string"),
    ]);
    expect(auditCliSourceMap("m", validMap({ sources: [""] }))).toEqual([
      expect.stringContaining("sources[0] is not a non-empty string"),
    ]);
  });

  it("refuses malformed JSON and a non-object map", () => {
    expect(auditCliSourceMap("m", "{")).toEqual([expect.stringContaining("not valid JSON")]);
    expect(auditCliSourceMap("m", "[]")).toEqual([expect.stringContaining("not an object")]);
  });

  it("reports every offending entry, not only the first", () => {
    const failures = auditCliSourceMap(
      "m",
      validMap({ sourcesContent: ["a", "b"], sources: ["/abs/x.ts", "../../../../y.ts"] }),
    );
    expect(failures).toHaveLength(4);
  });
});

describe("the packed map", () => {
  /**
   * The workspace map and the packed map are different files: `prepack` rebuilds, and only the
   * packed one ships. `packed-tarball-contract.mjs` audits the packed one; this proves the two
   * agree today, so a divergence shows up as a failure here rather than as a surprise at release.
   */
  it("is byte-identical to the built map", () => {
    const tarball = process.env.FAIRUX_PACKED_TARBALL;
    if (!tarball || !existsSync(tarball)) {
      // Packing here would cost a full rebuild in a unit test. `pnpm pack:smoke` and
      // `pnpm release:check:cli --tarball` both run the packed audit for real.
      expect(existsSync(builtMap)).toBe(true);
      return;
    }
    const packed = execFileSync("tar", ["-xzOf", tarball, "package/dist/index.js.map"], {
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
    });
    expect(packed).toBe(readFileSync(builtMap, "utf8"));
  });
});
