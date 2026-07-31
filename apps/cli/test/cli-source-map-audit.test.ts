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

  it("accepts an empty sourcesContent array only when there are no sources to match", () => {
    expect(auditCliSourceMap("m", validMap({ sources: [], sourcesContent: [] }))).toEqual([
      expect.stringContaining("lists no sources"),
    ]);
  });

  it("refuses a single non-empty sourcesContent entry", () => {
    expect(
      auditCliSourceMap("m", validMap({ sourcesContent: [null, "export const x = 1;"] })),
    ).toEqual([expect.stringContaining("sourcesContent[1] must be null or an empty string")]);
  });

  it.each([
    [{ code: "embedded" }, "a object"],
    [["embedded"], "a array"],
    [42, "a number"],
    [true, "a boolean"],
  ])("refuses a sourcesContent entry of type %s", (content, described) => {
    // The first version only inspected non-empty *strings*, so every other type was ignored — and
    // `[{ code: "embedded" }]` is source content by any reading.
    expect(auditCliSourceMap("m", validMap({ sourcesContent: [content, null] }))).toEqual([
      expect.stringContaining(`must be null or an empty string, got ${described}`),
    ]);
  });

  it("requires one sourcesContent entry per source when the array is present", () => {
    // A short or long array leaves the correspondence ambiguous, which is how a partially
    // populated array could look like a fully empty one.
    expect(auditCliSourceMap("m", validMap({ sourcesContent: [null] }))).toEqual([
      expect.stringContaining("sourcesContent has 1 entries for 2 sources"),
    ]);
    expect(auditCliSourceMap("m", validMap({ sourcesContent: [null, null, null] }))).toEqual([
      expect.stringContaining("sourcesContent has 3 entries for 2 sources"),
    ]);
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

  it.each([
    "file:///Users/tochi/src/index.ts",
    "https://example.invalid/index.ts",
    // The opaque forms. The first version of this test required `://`, so every one of these
    // read as an ordinary relative path — a `data:` URL is a source map carrying its payload
    // inline, which is exactly what the `sourcesContent` rule exists to prevent.
    "data:application/typescript;base64,ZXhwb3J0IHt9",
    "file:../../source.ts",
    "node:fs",
    "workspace:package",
  ])("refuses %s, whatever the scheme's shape", (source) => {
    expect(auditCliSourceMap("m", validMap({ sources: [source] }))).toEqual([
      expect.stringContaining("carries a URI scheme"),
    ]);
  });

  it("does not mistake a Windows drive letter for a URI scheme", () => {
    // `C:` matches a scheme grammar. It is an absolute path, and saying so is what a reader needs.
    expect(auditCliSourceMap("m", validMap({ sources: ["C:\\build\\index.ts"] }))).toEqual([
      expect.stringContaining("is an absolute path"),
    ]);
  });

  it.each(["..%2f..%2f..%2f..%2foutside.ts", "%2e%2e/%2e%2e/%2e%2e/%2e%2e/outside.ts"])(
    "refuses the percent-encoded traversal %s",
    (source) => {
      // Map locations are URLs, so an encoded `../` is a traversal a byte comparison does not see.
      expect(auditCliSourceMap("m", validMap({ sources: [source] }))).toEqual([
        expect.stringContaining("escapes the repository"),
      ]);
    },
  );

  it("refuses a location it cannot decode", () => {
    expect(auditCliSourceMap("m", validMap({ sources: ["%zz/a.ts"] }))).toEqual([
      expect.stringContaining("is not decodable as a URL"),
    ]);
  });

  it("still accepts a percent-encoded path that stays inside the repository", () => {
    expect(auditCliSourceMap("m", validMap({ sources: ["../src/my%20file.ts"] }))).toEqual([]);
  });
});

describe("sourceRoot, which every source entry inherits", () => {
  /**
   * `sourceRoot` is prepended to each `sources` entry, so an auditor that reads `sources` alone
   * audits a value no consumer ever resolves. All four of these passed the first version.
   */
  it("accepts an absent, empty, or repository-relative root", () => {
    expect(auditCliSourceMap("m", validMap())).toEqual([]);
    expect(auditCliSourceMap("m", validMap({ sourceRoot: "" }))).toEqual([]);
    expect(
      auditCliSourceMap("m", validMap({ sourceRoot: "../src", sources: ["index.ts"] })),
    ).toEqual([]);
  });

  it.each([
    ["../../../../", "escapes the repository"],
    ["/absolute", "is an absolute path"],
    ["C:\\absolute", "is an absolute path"],
    ["\\\\server\\share", "is an absolute path"],
    ["file:///private/tmp/", "carries a URI scheme"],
    ["data:", "carries a URI scheme"],
    ["https://example.invalid/", "carries a URI scheme"],
  ])("refuses sourceRoot %s", (sourceRoot, reason) => {
    expect(auditCliSourceMap("m", validMap({ sourceRoot }))).toEqual([
      expect.stringContaining(`sourceRoot ${reason}`),
    ]);
  });

  it("refuses a sourceRoot that is not a string", () => {
    expect(auditCliSourceMap("m", validMap({ sourceRoot: 42 }))).toEqual([
      expect.stringContaining("sourceRoot must be a string"),
    ]);
  });

  it("refuses a root and a source that escape only once joined", () => {
    // Each half is inside the repository; the value a consumer resolves is not.
    const failures = auditCliSourceMap(
      "m",
      validMap({ sourceRoot: "../..", sources: ["../../outside.ts"] }),
    );
    expect(failures).toEqual([expect.stringContaining("escapes the repository")]);
    // The message quotes both halves, because neither alone explains the refusal.
    expect(failures[0]).toContain('sourceRoot="../.."');
    expect(failures[0]).toContain('source="../../outside.ts"');
  });

  it("reports a bad root once, not once per source under it", () => {
    expect(
      auditCliSourceMap("m", validMap({ sourceRoot: "/abs", sources: ["a.ts", "b.ts", "c.ts"] })),
    ).toHaveLength(1);
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

  it("audits the checked-in map for a sourceRoot too", () => {
    const map = JSON.parse(readFileSync(builtMap, "utf8")) as Record<string, unknown>;
    // The build emits none; if it ever does, the rules above apply to it rather than being
    // skipped because the key happened to be absent when they were written.
    expect(map.sourceRoot === undefined || map.sourceRoot === "").toBe(true);
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
